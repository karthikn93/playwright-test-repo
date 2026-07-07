import fs from "fs";
import { execSync } from "child_process";

interface TestFailure {
  testName: string;
  errorMessage: string;
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
  projectName: string;
  status: string;
  duration: number;
}

interface AIAnalysis {
  summary: string;
  category: "BACKEND" | "FRONTEND" | "TEST_DATA" | "FLAKY" | "UNKNOWN";
  rootCause: string;
  suggestedFix: string;
  reRunCommand: string;
}

/**
 * Step 1: Parse Playwright JSON report to extract failures
 * Updated to match your actual JSON structure
 */
function parsePlaywrightFailures(reportPath: string): TestFailure[] {
  if (!fs.existsSync(reportPath)) {
    console.log("⚠️ No test report found at:", reportPath);
    return [];
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const failures: TestFailure[] = [];

  // Navigate through the report structure
  for (const suite of report.suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        // Check if the test failed (status is 'unexpected')
        if (test.status === "unexpected") {
          // Get the first result (or the one with errors)
          const result = test.results?.[0];
          const error = result?.errors?.[1] || result?.errors?.[0];

          // Extract error message and location
          let errorMessage = "Unknown error";
          let lineNumber: number | undefined;
          let columnNumber: number | undefined;

          if (error) {
            // The error message might be in the message field or in the stack
            errorMessage = error.message || "Unknown error";

            // Try to extract line/column from location if available
            if (error.location) {
              lineNumber = error.location.line;
              columnNumber = error.location.column;
            }
          }

          failures.push({
            testName: test.title || spec.title || "Unknown test",
            errorMessage: errorMessage,
            filePath: spec.file || test.file || "Unknown file",
            lineNumber: lineNumber,
            columnNumber: columnNumber,
            projectName: test.projectName || test.projectId || "Unknown",
            status: result?.status || test.status || "failed",
            duration: result?.duration || 0,
          });
        }
      }
    }
  }

  return failures;
}

/**
 * Step 2: Build a focused prompt for the AI
 */
function buildAIPrompt(failures: TestFailure[]): string {
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
              Browser: ${f.projectName}
              Duration: ${f.duration}ms
              Error: ${cleanError}
              ---`;
    })
    .join("\n");

  return `You are a Senior Software Test Automation Engineer analyzing Playwright test failures.

Here are ${failures.length} test failure(s) from the CI pipeline:

${failureDetails}

Analyze these failures and provide a response in this EXACT format:

SUMMARY: (One sentence summarizing the main issue)
CATEGORY: (Choose one: BACKEND, FRONTEND, TEST_DATA, FLAKY, or UNKNOWN)
ROOT_CAUSE: (Detailed explanation of why this happened, 2-3 sentences)
FIX: (Actionable suggestion for the developer, 2-3 sentences)
RE_RUN: (The exact npx playwright command to re-run this specific test)

Be specific and practical. If the error is about a missing locator, suggest the correct selector. If it's a timeout, suggest a fix.

Note:
1. Locate the failing Playwright tests in the repository.
2. Inspect related page objects, fixtures, and helper functions.
3. Determine the most likely root cause.
4. Suggest the minimal code changes needed.
5. Do not modify any files.`;
}

/**
 * Step 3: Call GitHub Copilot CLI
 */
function callCopilot(prompt: string): string {
  console.log("🧠 Asking GitHub Copilot to analyze the test failures...");

  // Check if Copilot CLI is installed
  try {
    execSync("which copilot", { encoding: "utf-8" });
  } catch {
    console.log("📦 Installing GitHub Copilot CLI...");
    execSync("npm install -g @github/copilot-cli", { encoding: "utf-8" });
  }

  try {
    // Write prompt to temp file to avoid escaping issues
    const tempFile = "/tmp/copilot-prompt.txt";
    fs.writeFileSync(tempFile, prompt);

    // Call Copilot with the prompt
    const result = execSync(
      `copilot -p "$(cat ${tempFile})" --deny-tool='shell(git:*)'`,
      {
        encoding: "utf-8",
        timeout: 45000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // fs.unlinkSync(tempFile);
    return result.trim();
  } catch (error) {
    const err = error as Error;
    console.error("❌ Copilot CLI error:", err.message);
    throw new Error(`Failed to call Copilot: ${err.message}`);
  }
}
/**
 * Step 4: Parse AI response into structured format
 */
function parseAIResponse(aiResponse: string): AIAnalysis {
  const defaultResponse: AIAnalysis = {
    summary: "Unable to parse AI response",
    category: "UNKNOWN",
    rootCause: "Please check the test logs manually",
    suggestedFix: "Review the test code and application state",
    reRunCommand: "npx playwright test",
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
    const validCategories: AIAnalysis["category"][] = [
      "BACKEND",
      "FRONTEND",
      "TEST_DATA",
      "FLAKY",
      "UNKNOWN",
    ];
    const parsedCategory = validCategories.includes(category as any)
      ? (category as AIAnalysis["category"])
      : "UNKNOWN";

    return {
      summary: summaryMatch?.[1]?.trim() || defaultResponse.summary,
      category: parsedCategory,
      rootCause: rootCauseMatch?.[1]?.trim() || defaultResponse.rootCause,
      suggestedFix: fixMatch?.[1]?.trim() || defaultResponse.suggestedFix,
      reRunCommand: rerunMatch?.[1]?.trim() || defaultResponse.reRunCommand,
    };
  } catch (error) {
    const err = error as Error;
    console.error("⚠️ Failed to parse AI response:", err.message);
    return defaultResponse;
  }
}

/**
 * Step 5: Generate a human-readable report
 */
function generateReport(analysis: AIAnalysis, failures: TestFailure[]): string {
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
function saveReport(analysis: AIAnalysis, failures: TestFailure[]): void {
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
 * Step 5: Generate fallback analysis without AI
 */
function generateFallbackAnalysis(prompt: string): string {
  // Parse the prompt to extract test information
  const lines = prompt.split("\n");
  let testName = "Unknown test";
  let errorMessage = "Unknown error";
  let filePath = "Unknown file";
  let browser = "Unknown browser";

  for (const line of lines) {
    if (line.startsWith("Test:")) {
      testName = line.replace("Test:", "").trim();
    }
    if (line.startsWith("File:")) {
      filePath = line.replace("File:", "").trim();
    }
    if (line.startsWith("Browser:")) {
      browser = line.replace("Browser:", "").trim();
    }
    if (line.startsWith("Error:")) {
      errorMessage = line.replace("Error:", "").trim();
    }
  }

  // Basic analysis based on error patterns
  let category: string = "UNKNOWN";
  let rootCause = "Unable to determine root cause";
  let fix = "Please check the test logs manually";
  let rerun = `npx playwright test ${filePath}`;

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

  // Parse failures from Playwright report
  const reportPath = process.argv[2] || "test-results.json";
  const failures = parsePlaywrightFailures(reportPath);

  if (failures.length === 0) {
    console.log("✅ No test failures found! All tests passed.");
    console.log("📊 Total tests: All passed");
    process.exit(0);
  }

  console.log(
    `📊 Found ${failures.length} failed test(s) across ${new Set(failures.map((f) => f.projectName)).size} browser(s)`,
  );
  failures.forEach((f, i) => {
    console.log(`   ${i + 1}. ${f.testName} (${f.projectName})`);
  });
  console.log("");

  // Build prompt and call Copilot
  const prompt = buildAIPrompt(failures);
  console.log("📝 Sending prompt to AI...\n");

  let aiResponse: string;
  try {
    aiResponse = callCopilot(prompt);
  } catch (error) {
    const err = error as Error;
    console.error("❌ AI analysis failed:", err.message);
    console.log("📋 Using fallback analysis...");
    aiResponse = generateFallbackAnalysis(prompt);
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
  const err = error as Error;
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
