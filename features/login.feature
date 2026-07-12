Feature: User Authentication
  As a user, I want to log into the system swiftly using valid credentials.

  @smoke
  Scenario: Successful login with valid credentials
    Given the user navigates to the login page
    When the user enters correct username and password
    Then the homepage dashboard should display

  @smoke
  Scenario: Failed login with invalid credentials
    Given the user navigates to the login page
    When the user enters incorrect username and password
    Then an error message should be displayed
