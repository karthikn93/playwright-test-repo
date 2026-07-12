const { Given, When, Then, Before, After } = require("@cucumber/cucumber");
const { chromium } = require("playwright");

let browser;
let page;

// Using https://the-internet.herokuapp.com/login as a public test login page
const BASE_URL = "https://the-internet.herokuapp.com/login";
const VALID_USERNAME = "tomsmith";
const VALID_PASSWORD = "SuperSecretPassword!";

Before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
});

After(async () => {
  await browser.close();
});

Given("the user navigates to the login page", async () => {
  await page.goto(BASE_URL);
  await page.waitForSelector("#username");
});

When("the user enters correct username and password", async () => {
  await page.fill("#username", VALID_USERNAME);
  await page.fill("#password", VALID_PASSWORD);
  await page.click('button[type="submit"]');
});

When("the user enters incorrect username and password", async () => {
  await page.fill("#username", "wronguser");
  await page.fill("#password", "wrongpassword");
  await page.click('button[type="submit"]');
});

Then("the homepage dashboard should display", async () => {
  await page.waitForSelector(".flash.success");
  const message = await page.textContent(".flash.success");
  if (!message.includes("You logged into a secure areas!")) {
    throw new Error(`Expected success message but got: ${message.trim()}`);
  }
});

Then("an error message should be displayed", async () => {
  await page.waitForSelector(".flash.error");
  const message = await page.textContent(".flash.error");
  if (!message.includes("Your username is invalid!")) {
    throw new Error(`Expected error message but got: ${message.trim()}`);
  }
});
