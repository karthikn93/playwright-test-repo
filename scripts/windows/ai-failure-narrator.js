const fs = require("fs");
const { execSync, spawnSync } = require("child_process");
const os = require("os");
const path = require("path");

/**
 * Step 1: Parse Cucumber JSON report to extract failures
 * Supports Cucumber JSON format: features[] > elements[] > steps[]
 */
function parsePlaywrightFailures(reportPath) {
  if (!fs.existsSync(reportPath)) {
    console.log("⚠️ No test report found at:", reportPath);
    return [];
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const failures = [];

  // Cucumber JSON is a top-level array of features
  for (const feature of report) {
    // Each feature contains elements (scenarios/scenario outlines)
    for (const scenario of feature.elements || []) {
      // Find the first failed step in this scenario
      const failedStep = scenario.steps?.find(
        (step) => step.result?.status === "failed",
      );

      if (!failedStep) continue; // Skip passed scenarios

      // Error message is in result.error_message for Cucumber
      const errorMessage = failedStep.result?.error_message || "Unknown error";

      // Extract step definition file path and line from match.location
      // e.g. "step-definitions/loginSteps.ts:10"
      const stepLocation = failedStep.match?.location || "";
      const [stepFile, stepLine] = stepLocation.split(":");
      const lineNumber = stepLine ? parseInt(stepLine, 10) : failedStep.line;

      // Cucumber durations are in nanoseconds — convert to milliseconds
      const totalDurationMs = Math.round(
        (scenario.steps || []).reduce(
          (sum, step) => sum + (step.result?.duration || 0),
          0,
        ) / 1_000_000,
      );

      failures.push({
        // Combine scenario name + failed step for clear identification
        testName: `${scenario.name} → ${failedStep.keyword.trim()} ${failedStep.name}`,
        errorMessage,
        // Use feature file URI as the primary file path
        filePath: feature.uri || stepFile || "Unknown file",
        lineNumber,
        columnNumber: undefined, // Not available in Cucumber JSON
        // Use feature name as the "project" equivalent
        projectName: feature.name || "Unknown feature",
        status: "failed",
        duration: totalDurationMs,
      });
    }
  }

  return failures;
}

/**
 * Step 2: Build a focused prompt for the AI
 */
function buildAIPrompt(failures) {
  const failureDetails = failures
    .map((f, i) => {
      // Clean up ANSI color codes from error messages
      const cleanError = f.errorMessage
        .replace(/\u001b\[[0-9;]*m/g, "") // Remove ANSI color codes
        .split("\n")
        .slice(0, 3) // First 3 lines only to keep it focused
        .join("\n")
        .trim();

      return `[Failure ${i + 1}]
              Test: ${f.testName}
              File: ${f.filePath}${f.lineNumber ? `:${f.lineNumber}` : ""}
              Feature: ${f.projectName}
              Duration: ${f.duration}ms
              Error: ${cleanError}
              ---`;
    })
    .join("\n");

  return `You are a Senior Software Test Automation Engineer analyzing Cucumber test failures.

Here are ${failures.length} test failure(s) from the CI pipeline:

${failureDetails}

Analyze these failures and provide a response in this EXACT format:

SUMMARY: (One sentence summarizing the main issue)
CATEGORY: (Choose one: BACKEND, FRONTEND, TEST_DATA, FLAKY, or UNKNOWN)
ROOT_CAUSE: (Detailed explanation of why this happened, 2-3 sentences)
FIX: (Actionable suggestion for the developer, 2-3 sentences)
RE_RUN: (The exact npx cucumber-js command to re-run this specific scenario)

Be specific and practical. If the error is about a missing locator, suggest the correct selector. If it's a timeout, suggest a fix.

Note:
1. Locate the failing Cucumber tests in the repository.
2. Inspect related step definitions, page objects, and helper functions.
3. Determine the most likely root cause.
4. Suggest the minimal code changes needed.
5. Do not modify any files.`;
}

/**
 * Step 3: Call GitHub Copilot CLI
 */
function callCopilot(prompt) {
  console.log("🧠 Asking GitHub Copilot to analyze the test failures...");

  // Use 'where' on Windows to check if Copilot CLI is installed
  try {
    execSync("where copilot", { encoding: "utf-8" });
  } catch {
    console.log("📦 Installing GitHub Copilot CLI...");
    execSync("npm install -g @github/copilot", { encoding: "utf-8" });
  }

  try {
    // Use os.tmpdir() for Windows-compatible temp directory
    // e.g. C:\Users\user\AppData\Local\Temp
    const tempFile = path.join(os.tmpdir(), "copilot-prompt.txt");
    fs.writeFileSync(tempFile, prompt, "utf-8");

    // Use spawnSync with args array — avoids shell escaping issues on Windows
    // Reads prompt directly from file instead of using $(cat file) bash syntax
    const result = spawnSync(
      "copilot",
      ["-p", fs.readFileSync(tempFile, "utf-8"), "--deny-tool=shell(git:*)"],
      {
        encoding: "utf-8",
        timeout: 45000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr || "Copilot exited with non-zero status");
    }

    // fs.unlinkSync(tempFile);
    return result.stdout.trim();
  } catch (error) {
    console.error("❌ Copilot CLI error:", error.message);
    throw new Error(`Failed to call Copilot: ${error.message}`);
  }
}

/**
 * Step 4: Parse AI response into structured format
 */
function parseAIResponse(aiResponse) {
  const defaultResponse = {
    summary: "Unable to parse AI response",
    category: "UNKNOWN",
    rootCause: "Please check the test logs manually",
    suggestedFix: "Review the test code and application state",
    reRunCommand: "npx cucumber-js",
  };

  try {
    const summaryMatch = aiResponse.match(/SUMMARY:\s*(.+?)(?=\n|$)/i);
    const categoryMatch = aiResponse.match(/CATEGORY:\s*(.+?)(?=\n|$)/i);
    const rootCauseMatch = aiResponse.match(
      /ROOT_CAUSE:\s*([\s\S]+?)(?=FIX:|$)/i,
    );
    const fixMatch = aiResponse.match(/FIX:\s*([\s\S]+?)(?=RE_RUN:|$)/i);
    const rerunMatch = aiResponse.match(/RE_RUN:\s*(.+?)(?=\n|$)/i);

    const category = (categoryMatch?.[1]?.trim() || "").toUpperCase();
    const validCategories = [
      "BACKEND",
      "FRONTEND",
      "TEST_DATA",
      "FLAKY",
      "UNKNOWN",
    ];
    const parsedCategory = validCategories.includes(category)
      ? category
      : "UNKNOWN";

    return {
      summary: summaryMatch?.[1]?.trim() || defaultResponse.summary,
      category: parsedCategory,
      rootCause: rootCauseMatch?.[1]?.trim() || defaultResponse.rootCause,
      suggestedFix: fixMatch?.[1]?.trim() || defaultResponse.suggestedFix,
      reRunCommand: rerunMatch?.[1]?.trim() || defaultResponse.reRunCommand,
    };
  } catch (error) {
    console.error("⚠️ Failed to parse AI response:", error.message);
    return defaultResponse;
  }
}

/**
 * Step 5: Generate a human-readable report
 */
function generateReport(analysis, failures) {
  const separator = "=".repeat(55);
  const line = "-".repeat(55);

  const failedTestsList = failures
    .map((f, i) => `   ${i + 1}. ${f.testName} (${f.projectName})`)
    .join("\n");

  return `
${separator}
🧠 AI FAILURE NARRATOR
${separator}
📊 Found ${failures.length} failed test(s):
${failedTestsList}

${line}

📝 SUMMARY:
   ${analysis.summary}

🏷️  CATEGORY: ${analysis.category}

🔍 ROOT CAUSE:
   ${analysis.rootCause}

🔧 SUGGESTED FIX:
   ${analysis.suggestedFix}

▶️  RE-RUN COMMAND:
   ${analysis.reRunCommand}

${separator}
✅ AI analysis complete!
📄 Full details saved to: ai-failure-report.json
${separator}
`;
}

/**
 * Step 6: Save structured report
 */
function saveReport(analysis, failures) {
  const report = {
    timestamp: new Date().toISOString(),
    totalFailures: failures.length,
    analysis: {
      summary: analysis.summary,
      category: analysis.category,
      rootCause: analysis.rootCause,
      suggestedFix: analysis.suggestedFix,
      reRunCommand: analysis.reRunCommand,
    },
    failures: failures.map((f) => ({
      testName: f.testName,
      filePath: f.filePath,
      lineNumber: f.lineNumber,
      projectName: f.projectName,
      status: f.status,
      duration: f.duration,
      error: f.errorMessage.split("\n")[0], // First line only
    })),
  };

  fs.writeFileSync("ai-failure-report.json", JSON.stringify(report, null, 2));
  console.log("📄 Full report saved to: ai-failure-report.json");
}

/**
 * Step 7: Generate fallback analysis without AI
 */
function generateFallbackAnalysis(prompt) {
  // Parse the prompt to extract test information
  const lines = prompt.split("\n");
  let testName = "Unknown test";
  let errorMessage = "Unknown error";
  let filePath = "Unknown file";
  let browser = "Unknown browser";

  for (const line of lines) {
    if (line.trim().startsWith("Test:")) {
      testName = line.replace("Test:", "").trim();
    }
    if (line.trim().startsWith("File:")) {
      filePath = line.replace("File:", "").trim();
    }
    if (line.trim().startsWith("Feature:")) {
      browser = line.replace("Feature:", "").trim();
    }
    if (line.trim().startsWith("Error:")) {
      errorMessage = line.replace("Error:", "").trim();
    }
  }

  // Basic analysis based on error patterns
  let category = "UNKNOWN";
  let rootCause = "Unable to determine root cause";
  let fix = "Please check the test logs manually";
  let rerun = `npx cucumber-js ${filePath}`;

  if (errorMessage.toLowerCase().includes("timeout")) {
    if (
      errorMessage.toLowerCase().includes("locator") ||
      errorMessage.toLowerCase().includes("selector")
    ) {
      category = "FRONTEND";
      rootCause =
        "The test timed out because the element was not found. This usually happens when the selector is incorrect or the element is not visible on the page.";
      fix =
        "Check if the locator text matches exactly. Common issues: typos, case sensitivity, or whitespace differences.";
    } else {
      category = "BACKEND";
      rootCause =
        "The test timed out waiting for a response or page load. This could be due to slow API responses or network issues.";
      fix =
        "Consider increasing the timeout value or checking the API response times.";
    }
  } else if (
    errorMessage.toLowerCase().includes("500") ||
    errorMessage.toLowerCase().includes("internal server")
  ) {
    category = "BACKEND";
    rootCause =
      "The server returned a 500 Internal Server Error, indicating a server-side issue.";
    fix =
      "Check the server logs for more details about what caused the internal server error.";
  } else if (
    errorMessage.toLowerCase().includes("404") ||
    errorMessage.toLowerCase().includes("not found")
  ) {
    category = "BACKEND";
    rootCause =
      "The requested resource was not found (404). This could be due to an incorrect URL or missing endpoint.";
    fix =
      "Verify the API endpoint URL and ensure the service is properly deployed.";
  } else if (
    errorMessage.toLowerCase().includes("assert") ||
    errorMessage.toLowerCase().includes("expected")
  ) {
    category = "TEST_DATA";
    rootCause =
      "The test assertion failed because the actual value did not match the expected value.";
    fix =
      "Check the test data and verify that the application state is correct before the assertion.";
  } else {
    category = "FRONTEND";
    rootCause = "The test failed due to a UI or element interaction issue.";
    fix =
      "Check the application UI and ensure all elements are correctly rendered and accessible.";
  }

  return `SUMMARY: Test "${testName}" failed with error: ${errorMessage}
CATEGORY: ${category}
ROOT_CAUSE: ${rootCause}
FIX: ${fix}
RE_RUN: ${rerun}`;
}

/**
 * Main function
 */
async function main() {
  console.log("\n🚀 Starting AI Failure Narrator...\n");

  // Parse failures from Cucumber report
  const reportPath = process.argv[2] || "test-results.json";
  const failures = parsePlaywrightFailures(reportPath);

  if (failures.length === 0) {
    console.log("✅ No test failures found! All tests passed.");
    console.log("📊 Total tests: All passed");
    process.exit(0);
  }

  console.log(
    `📊 Found ${failures.length} failed test(s) across ${new Set(failures.map((f) => f.projectName)).size} feature(s)`,
  );
  failures.forEach((f, i) => {
    console.log(`   ${i + 1}. ${f.testName} (${f.projectName})`);
  });
  console.log("");

  // Build prompt and call Copilot
  const prompt = buildAIPrompt(failures);
  console.log("📝 Sending prompt to AI...\n");

  let aiResponse;
  try {
    aiResponse = callCopilot(prompt);
  } catch (error) {
    console.error("❌ AI analysis failed:", error.message);
    // console.log("📋 Using fallback analysis...");
    // aiResponse = generateFallbackAnalysis(prompt);
  }

  // Parse AI response
  const analysis = parseAIResponse(aiResponse);

  // Generate and display report
  const report = generateReport(analysis, failures);
  console.log(report);

  // Save structured report for artifacts
  saveReport(analysis, failures);
}

// Run the main function
main().catch((error) => {
  console.error("❌ Fatal error:", error.message);
  process.exit(1);
});
