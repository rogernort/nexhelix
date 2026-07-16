# NexHelix Research Survey

A self-hosted research survey: a single static HTML page (`index.html`) that posts
submissions to a Google Apps Script Web App (`apps-script.gs`), which writes rows to a
Google Sheet and saves uploaded files to a Drive folder. Everything runs inside your
Google account — no hosting cost, no third-party form tool.

```
index.html  ──POST (JSON as text/plain)──►  Apps Script Web App
                                              ├─► Google Sheet  (one row per response)
                                              └─► Drive folder  (uploaded files, links in the row)
```

## Setup (one-time, ~10 minutes)

### 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Delete the placeholder code and paste in the full contents of `apps-script.gs`.
3. Name the project (e.g. "NexHelix Survey Backend") and save (Cmd+S).

### 2. Run `testSetup()` once

1. In the toolbar function dropdown, pick `testSetup`, then click **Run**.
2. Google will ask for permissions (Sheets + Drive). Approve them.
   You'll likely see a "Google hasn't verified this app" warning — click
   **Advanced → Go to (project name)**. That's normal for your own scripts.
3. Check the execution log: it prints the URLs of the **Responses sheet** and the
   **Uploads folder** it just created. Bookmark both.

You don't need to create the Sheet or folder manually — the script makes them and
remembers their IDs. (If you'd rather use an existing Sheet/folder, paste their IDs
into `CONFIG.SPREADSHEET_ID` / `CONFIG.FOLDER_ID` at the top of the script.)

### 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon and choose type **Web app**.
3. Set:
   - **Execute as:** Me (your account)
   - **Who has access:** Anyone
4. Click **Deploy** and copy the Web App URL — it ends in `/exec`.
5. Sanity check: open that URL in a browser tab. You should see
   "NexHelix research endpoint is live."

### 4. Connect the form

Open `index.html` in a text editor and find the `CONFIG` block near the top of the
`<script>`:

```js
const CONFIG = {
  ENDPOINT: "PASTE_YOUR_APPS_SCRIPT_URL_HERE",
  FORM_VERSION: "v1.0",
  ...
};
```

Replace the placeholder with your `/exec` URL. Done.

### 5. Host the page

Any of these work — the page is a single file with zero dependencies:

- **Just open it locally** — double-click `index.html`. Submissions work fine from a
  `file://` page. Good for testing; not shareable.
- **GitHub Pages** (free, shareable) — push this folder to a repo, then
  Settings → Pages → deploy from branch. Your survey lives at
  `https://<you>.github.io/<repo>/`.
- **Netlify Drop** (fastest) — go to [app.netlify.com/drop](https://app.netlify.com/drop)
  and drag the folder in. You get a URL in seconds.

### 6. Test a submission

1. Open the page, fill it in (attach a small test file), submit.
2. Confirm: a new row in the Responses sheet, your file in the Uploads folder, and
   the file's Drive link in the `uploaded_files` column.
3. Delete the test row and file, and you're live.

If submission fails, the page shows an error banner and keeps the person's answers so
they can retry. The most common causes: the `/exec` URL wasn't pasted in, or the
deployment's access isn't set to "Anyone".

## Editing questions between waves (the important bit)

The entire survey is defined in one config array in `index.html` — `QUESTIONS` — plus
a `SECTIONS` array for the six parts. To add, reword, reorder or remove a question,
edit that array only. Example — adding a question is one entry:

```js
{ id: "ai_spend", section: "setup", type: "radio", required: false,
  label: "Roughly what do you spend on AI tools per month, personally?",
  options: ["Nothing", "Under $20", "$20–50", "$50–200", "More than $200"] },
```

Supported types: `text`, `email`, `textarea`, `radio`, `checkbox`, `select`, `scale`,
`file`, `consent`. Add `allowOther: true` to any radio/checkbox to get an "Other"
option with a free-text box. Add `showIf: { q: "<question id>", value: "<option>" }`
to make a question appear only while that option is ticked on another question.

Textareas get a mic button in browsers that support speech recognition (Chrome,
Edge, Safari): the respondent speaks, the transcript lands in the box as editable
text. No audio is stored, only the transcript. The button doesn't render in
unsupported browsers (Firefox).

Two rules when you edit:

1. **Bump `CONFIG.FORM_VERSION`** (e.g. `"v1.1"`). It's written into every row, so you
   can always tell which wave of the survey a response came from.
2. **Don't reuse an old `id` for a different question.** Columns are keyed by id, so
   reusing one would mix old and new answers in the same column. New id = new column.

The backend never breaks on survey changes: rows are written column-by-column using
the question ids in the header row, and any id it hasn't seen before gets a fresh
column appended automatically. Removed questions simply leave their column blank for
new rows. You do **not** need to touch or redeploy the Apps Script when you edit
questions.

(You only need to redeploy Apps Script if you change `apps-script.gs` itself — in
that case use **Deploy → Manage deployments → edit → new version** so the URL stays
the same.)

## Notes and small print

- **File uploads** are capped at 10MB per file / ~24MB per submission on the client,
  with a 15MB per-file safety cap server-side. Accepted: md, txt, pdf, doc(x), json,
  zip, csv and common image types.
- **CORS:** the page posts JSON with `Content-Type: text/plain`. That's deliberate —
  it's the standard workaround for Apps Script web apps, which reject preflighted
  JSON posts. Don't "fix" it to `application/json`.
- **Spam:** there's a hidden honeypot field; the backend silently drops any
  submission that fills it.
- **Concurrency:** the script takes a lock per submission, so simultaneous responses
  won't clobber each other.
- **Privacy promises in the form:** the intro and consent copy tell respondents their
  data is research-only and deletable on request — make sure you're set up to honour
  that (the Sheet + Drive folder are the only two places data lands).
