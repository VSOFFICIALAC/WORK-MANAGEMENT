# Workbench — Google Apps Script edition

A Google-only task planner for students and professionals across any field. Features include the 4×4 focus-and-duration matrix, Ikigai reflection view, customizable projects, meeting calendar, light and dark themes, task animations, and email reminders. There are no preloaded domain-specific tasks or projects.

## Accounts and data

Users register with an email address and password, verify the email address with a one-time code, and sign in to Workbench. Passwords are stored as salted PBKDF2-HMAC-SHA256 hashes. Sessions expire and are checked on each data request. Registration and password reset are rate-limited. Each account gets a separate spreadsheet owned by the app operator; the sheet is not shared with the user. The app sends verification and reminder emails from the operator's Google account. It does not request access to a user's Gmail, Drive, or Calendar. Existing data from the earlier Google-authorized version is not automatically imported into new Workbench accounts.

Apps Script access is a separate outer gate: the web app is configured for **Anyone with a Google account**, so visitors must be signed in to Google to open the page. This does not ask them to authorize the app to read their Google data.

## Deploy

1. Open [script.google.com](https://script.google.com/) with the Google account that will own the app. Create a project and add `Code.gs` plus HTML files named `Index`, `Styles`, `Bridge`, `Client`, `PostClient`, and `Privacy`. Enable the `appsscript.json` manifest in Project Settings and copy this folder's manifest into the project.
2. Set the project time zone to **Asia/Kolkata**.
3. Deploy as a web app with **Execute as: Me** and **Who has access: Anyone with a Google account**. The operator must authorize Google Sheets, Drive file creation, email sending, and time triggers for the app. Re-deploy a new version after changes.
4. Open the deployment URL. Users sign in to Google to open the page, then create or use their separate Workbench credentials.

## Reminders and limits

A five-minute Apps Script trigger checks each user's private sheet and sends due task and meeting reminders to their verified address. Timing can vary, and Google quotas apply. The owner-operated script can send mail only within the owner's service quota. This project does not scan Gmail or add meetings to a user's personal Google Calendar.
