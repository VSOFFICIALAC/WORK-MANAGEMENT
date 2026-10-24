# Workbench — Google Apps Script app

> **This website is intended to run as a Google Apps Script web app.** The files in this folder are Apps Script project source files, not a standalone website. Do not open `Index.html` directly from File Explorer or use this folder as a GitHub Pages site. Its template includes and server calls are processed by Apps Script; without them, the page will appear unstyled and its features will not work.

## What it does

Workbench helps students and professionals organize tasks by focus and duration, use a 4×4 priority matrix and Ikigai view, manage projects, and schedule meetings. It includes light and dark themes plus task and meeting email reminders.

## Run it in Google Apps Script

1. Go to [script.google.com](https://script.google.com/) and create a project.
2. Copy `Code.gs` into a script file named `Code`. Create HTML files named `Index`, `Styles`, `Bridge`, `Client`, `PostClient`, and `Privacy`, and copy in the matching source files from this folder.
3. In Project Settings, enable the `appsscript.json` manifest and copy in this folder's manifest.
4. Deploy the project as a web app. The manifest is configured to run as the deployer and require visitors to be signed in to a Google account. Visitors then use their separate Workbench email and password.
5. Open the deployed Apps Script URL to use the app.

The app stores each Workbench account's data in a separate spreadsheet in the deployer's Drive. It sends email verification and reminders from the deployer's Google account. Users do not authorize access to their own Drive, Gmail, or Calendar.

## GitHub

GitHub can store and version this source code. GitHub Pages can only serve a static front end; it cannot run this Apps Script backend, account storage, or email reminders. Keep this folder as source for the Apps Script project and use the Apps Script deployment URL as the working website.

## Important

This folder contains the updated Workbench account and interface source. It has not yet been tested or deployed to the current live website. Existing user data from the earlier Google-authorized version is not automatically imported.
