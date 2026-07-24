# Invoice Automation — Employee Guide

A plain-language guide to the invoice dashboard. No technical background needed.

## What this system does

When a vendor invoice arrives at **billing@wcmcon.com**, the system automatically:

1. Reads the email and its PDF.
2. Figures out the vendor, dates, and amount.
3. Matches it to the right WCM project (and subproject, if applicable).
4. If it's confident in the match, saves a copy into that project's folder and logs it.
5. If it's *not* confident — or the document isn't really an invoice (a statement, a "your payment info changed" notice, etc.) — it still saves a copy, just into a "Needs Review" spot, and flags it so a person double-checks it.

Nothing is ever deleted or silently lost. Every invoice email that comes in ends up either filed automatically or waiting in a review pile — never skipped.

You don't need any special access to check on invoices — just the dashboard link (bookmark it; ask whoever manages the automation for the URL if you don't have it).

## Reading the dashboard

At the top you'll see summary cards, with a **time-frame selector** (top right) to switch between today / this week / this month / all time:

| Card | Meaning |
|---|---|
| **Total Processed** | All invoice emails handled |
| **Filed** | Auto-filed with high confidence — no action needed |
| **Needs Review** | The system wasn't sure, or it's a statement/non-invoice — take a look |
| **Not an Invoice** | Recognized as something other than an invoice (statement, Purchase Order, notice, etc.) |
| **Errors** | Something went wrong processing it — see below |

Below that, filters narrow the invoice list. The **Status** and **Project** filters are dropdowns where you can tick **several at once** (ticking a main project includes all its subprojects). You can also search by **vendor** or **invoice #**, set an **amount** range, and pick a **date range** — filtered by processed, received, or invoice date. A **Sort by** control reorders whatever the filters found (newest/oldest, by vendor, project, amount, or status).

Each row shows the invoice's processed date, received date, invoice date, vendor (with its invoice number underneath), project/subproject, amount, and status, plus quick actions:
- 📄 **Preview** the filed PDF right on the page — with an edit panel beside it and **Prev / Next** buttons to work through a stack without closing it
- ✉️ open the original email in Gmail
- ✏️ **edit** the row (fix the project, subproject, status, invoice #, amount, or currency)

## What each status means

- **Filed** — done, no action needed. Filed into the project's folder, organized by month.
- **Needs Review** — the system filed a copy (into the **Needs Review** folder) but wants a human to confirm: it wasn't sure about the project, the amount is unusually large, or the due date lands too soon after arrival (crams the pay period). Check it and correct it if needed (see below).
- **Duplicate** — the same invoice arrived again (a vendor re-send). It was **not** filed twice; the row's file link points at the original copy. Nothing to do unless the re-send was actually a *revised* invoice — then edit the row.
- **Captured** — the coordinator has captured this invoice and uploaded it to Procore/SmartBuild. Set it from the edit panel when that's done.
- **Paid** — confirmed paid (in Nexus). The file stays in its month folder either way.
- **Not an Invoice** — the AI reader determined this isn't actually a bill (could be a Purchase Order / Agreement, a statement, a receipt, a "your account info changed" email, etc.). It's filed under **Statements & Others**. Worth a quick glance to confirm it agrees with you.
- **Errors** — something prevented processing (most often: the email matched the billing label but didn't actually have a PDF attached). Open the Gmail link to see the original email and handle it manually.

## Fixing a misfiled invoice

If an invoice landed under the wrong project, subproject, or status, you can fix it yourself — no need to ask for help:

1. Find the row in the table and click the **pencil/edit icon** at the end of the row — or open the **PDF preview** (file icon) and use the edit panel right beside the document.
2. Change the **project**, **subproject**, **status**, **invoice #**, **amount**, or **currency**.
3. Click **Save**.

This doesn't just update the log — it also moves the actual file in Google Drive to the correct folder (and renames it if you corrected the invoice #), so the archive and the dashboard always agree. The system also **remembers your correction**: next time that same vendor sends an invoice, it applies what it learned (and still shows it to you to confirm).

Working through a pile? In the preview, use **‹ Prev / Next ›** to move to the next invoice without closing it — review, fix, Save, Next.

### Fixing several at once

If a batch of invoices all need the same fix (say, several from one vendor that all went to the wrong project):

1. Tick the **checkboxes** on each row you want to change — hold **Shift** and click to select a whole range, or use the header checkbox to select all shown.
2. Click **Edit selected** in the bar that appears.
3. Choose the project/subproject/status to apply, and Save. A progress bar shows them being re-filed one by one.

## Where filed invoices live in Drive

Invoices are organized like this:

```
Invoice Archive
└── <Project Number> - <Project Name>
    ├── <Subproject Number> - <Subproject Name>   (when the invoice is tied to a subproject)
    │   └── <Year-Month>                          (e.g. 2026-07 — the month processed)
    │       ├── (real invoices — Filed/Captured/Paid — sit right here)
    │       ├── Needs Review                      (invoices awaiting a person)
    │       └── Statements & Others               (non-invoices: statements, POs, notices)
    └── No Subprojects                            (invoices with no subproject assigned — same months inside)
```

Statuses never mix inside a month: real invoices at the month's root, review items in its Needs Review, non-invoices in its Statements & Others.

Files are named consistently: **`YYMMDD - InvoiceNumber - Vendor.pdf`** (the date is when it was processed) — so a folder of invoices sorts and reads cleanly.

If an invoice can't be matched to any known project at all, it goes into a top-level **_Unmatched** folder instead, so it's never lost — just flagged as needing a manual look.

## Sending feedback

See something wrong, confusing, or worth improving? Click the **feedback button** (bottom corner of the dashboard), type a short note, and send it. This doesn't require any special access, and there's no need to email anyone — it goes straight into a tracked list for follow-up.

## Start / Pause

The blue **Start/Pause** button at the top controls whether the automation is actively processing new invoice emails. If it's paused, new invoices simply wait in the inbox until it's resumed — nothing is lost either way. Generally leave this on unless you've been specifically told to pause it (e.g. for maintenance).

## Frequently asked questions

**Why is my invoice sitting in "Needs Review" instead of being filed automatically?**
Usually one of: the AI wasn't fully confident about the project match, the document looked more like a statement than a bill, or the due date is close enough to when it arrived that it's worth a second look before payment. The row's status area usually includes a short note explaining why.

**I just forwarded/received an invoice — why don't I see it yet?**
The system checks for new invoice emails on a short delay (roughly every 15 minutes) and processes a handful at a time, so during a busy stretch there can be a short backlog. Give it a little time before assuming something's wrong.

**The invoice date looks wrong.**
Some invoices print dates in a format that could be read two ways (e.g. is "09/07/2026" July 9th or September 7th?). The system resolves that ambiguity using the date the email arrived. If it still looks wrong on a specific invoice, use the feedback button to flag it.

**Who do I contact if something looks broken?**
Use the feedback button first — it's tracked and reviewed. For anything urgent, contact whoever manages the automation for your team.
