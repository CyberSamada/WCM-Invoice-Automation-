# "Ask about the invoice system" — Gemini Gem setup

A Gem in Google AI Studio that answers questions about how this system works: the logic, the code,
the folder structure, why a status behaves the way it does. No code to deploy and nothing to host.

## Build the upload files

```
node tools/build-gem-pack.js
```

Writes two files into `gem-pack/` (gitignored, so they never land in the repo):

| File | What's in it | Size |
|---|---|---|
| `01-how-it-works.md` | README, CLAUDE.md, the employee guide, SETUP, the plan doc, the property list, **plus a generated index of all ~305 functions** with a one-line purpose each | ~128 KB |
| `02-source.md` | Every server-side `.gs` file verbatim, in load order, plus `appsscript.json` and the deploy workflow | ~275 KB |

`Dashboard.html` is not shipped whole (it is mostly markup and CSS, which crowds out the parts that
answer questions); its browser-side functions are in the index, and every endpoint it calls lives in
`DashboardServer.gs` / `NexusSync.gs`, which are included in full. `LogoAsset.gs` is skipped — it is
about a megabyte of base64 image.

## Create the Gem

1. Go to **aistudio.google.com** and sign in with the Google account that owns the automation.
2. Open **Chat**, then in the right-hand panel set the model to a **Gemini** model with a long
   context window (any current 1M-token model handles both files at once).
3. Attach both files from `gem-pack/`.
4. Paste this as the **System instructions**:

   > You answer questions about WCM Construction Management's invoice automation: a Google Apps
   > Script system that reads vendor invoices from Gmail, extracts the fields with Gemini, files the
   > PDF into the right project folder in Drive, logs it to a Google Sheet, and serves an HTML
   > dashboard.
   >
   > The two attached files are the whole system. `01-how-it-works.md` is the documentation plus an
   > index of every function; `02-source.md` is the actual source code. Answer from those files, not
   > from general knowledge about Apps Script.
   >
   > Rules:
   > - When a question is about exact behaviour, quote or cite the specific function and file.
   > - Distinguish what the code does from what the docs claim. If they disagree, say so and trust
   >   the code.
   > - Functions ending in `_` are private by convention and cannot be called from the dashboard via
   >   `google.script.run`. Never suggest calling one from the browser.
   > - If something genuinely isn't in the files, say you don't know rather than inventing it.
   > - The audience is the team that runs this, not developers. Lead with the plain answer, then the
   >   code detail if it's relevant.

5. **Save as a Gem** so it keeps the files and instructions, and share it with whoever needs it.

## The catch, stated plainly

**A Gem has no link back to the repo.** Whatever you upload is frozen at that moment, so after any
change to the code the Gem is out of date and will answer confidently from the old version. That is
why `build-gem-pack.js` stamps a generation date at the top of both files and tells the reader to ask
for a refresh if it looks old.

So: **re-run the build and re-upload after a batch of changes.** If that turns into a chore, the
alternative is to put this in the dashboard instead, where Apps Script can send Gemini a knowledge
pack built at deploy time — same idea, no manual step, but it is real code to build and maintain.

## Good questions to test it with

- Why did this invoice end up in `_Unmatched` instead of a project folder?
- What is the difference between Captured, Paid and Canceled, and who sets each?
- How does the Nexus sync decide it is confident enough to change a status automatically?
- Why must I never move a `Duplicate` row's file?
- What happens if two invoices arrive in the same email?
- Where do the project hints live, and how do I add one without a code change?
