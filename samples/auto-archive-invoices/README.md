# Auto-archive payment invoices

**A working Daisy-workflow sample.** Drop it in, point it at your
inbox, and every payment confirmation that lands becomes a tidy folder
on disk with the email body, a parsed JSON summary, and every
attachment — ready for your accountant, ready for audit.

## The problem this solves

Most finance inboxes look the same: hundreds of messages per month,
maybe ten percent of them are payment confirmations or invoices for
payments your team has already made, and someone — usually the same
person, often a founder — spends an hour a week dragging them into
shared folders by year, by month, by vendor.

The tedious version of this task is exactly what software is good at,
but the "is this an invoice for a payment we made?" decision needs a
human judgment call most of the time. AI is now reliable enough to
make that call. Daisy is the glue.

## What this workflow does

```
  ┌──────────────┐
  │ Mail trigger │   (new email arrives on the inbox you configure)
  └──────┬───────┘
         │
         ▼
  ┌──────────────────┐
  │ AI agent         │   "Is this a payment invoice? If yes,
  │ classifies       │    extract vendor, amount, dates."
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │ Guard            │   Stops the flow when the answer is no.
  │ (executeIf)      │   No invoice = nothing happens. Free.
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │ Build path       │   payments/2026/05/16/Acme_Inc/
  │ (FEEL transform) │
  └──────┬───────────┘
         │
   ┌─────┼──────────────────┐
   │     │                  │
   ▼     ▼                  ▼
  body  invoice.json     attachments
  .txt                   (fanned out, one
                          file.write per file)
```

End result on disk:

```
/data/archive/
└── payments/
    └── 2026/
        └── 05/
            └── 16/
                └── Acme_Inc/
                    ├── email.txt
                    ├── invoice.json
                    ├── Acme-Invoice-1042.pdf
                    └── statement.csv
```

Every email is now searchable, versioned, and machine-readable.
Reconciliation jobs read `invoice.json` directly. Auditors get the
original `.pdf` and the email body that proves authorisation.

## What you set up

Four pieces, twelve minutes total:

1. **The inbox config.** Configurations → New → Mail (IMAP). Host,
   username, password, folder = `INBOX`. Done.

2. **The AI agent.** Configurations → New → AI provider. Paste your
   Anthropic or OpenAI key. Then Agents → New → name it
   `InvoiceClassifier` and use this prompt (tune to match your
   accounting categories):

   ```
   You classify incoming emails as either "a payment invoice we have
   already paid" or "anything else". You ONLY return strict JSON:

     {
       "isInvoice":      <true|false>,
       "vendor":         "<the company that received our payment>",
       "invoiceNumber":  "<their reference, or null>",
       "amount":         <number, or null>,
       "currency":       "<3-letter ISO code, or null>",
       "paymentDate":    "<YYYY-MM-DD, or null>",
       "confidence":     <0..1>
     }

   isInvoice is true ONLY when the email confirms a payment WE have
   made — e.g. a receipt from a SaaS vendor, an invoice marked PAID,
   a Stripe / PayPal payment notification. Bills we haven't paid yet,
   marketing emails, and statements are NOT invoices for our purposes.
   Use null for fields you cannot extract with confidence.
   ```

3. **The workflow.** Workflows → Import → paste `workflow.json` from
   this folder. Open it once to verify the `data.archiveRoot` matches
   where you actually want files written (default `/data/archive`).

4. **The trigger.** Triggers → New → Email. Pick the inbox config and
   the workflow. Save.

That's it. The next payment receipt that hits your inbox files itself.

## What's actually happening (for engineers)

Six nodes:

| Node | Plugin | Job |
|---|---|---|
| `classifyEmail` | `agent` | Sends `Subject + From + Date + Body` to your `InvoiceClassifier` agent and stores the JSON reply in `ctx.classification`. |
| `guard` | `transform` | `executeIf: ${classification.result.isInvoice = true}`. When false, Daisy cascade-skips every downstream node. Non-invoice mail costs you one agent call and zero file writes. |
| `buildPath` | `transform` | Slices `${input.date}` into year / month / day using FEEL `substring()`, sanitises the vendor name with `replace()` regex. Single FEEL expression, no glue code. |
| `saveBody` | `file.write` | Writes `email.txt`. Daisy creates parent directories on demand. |
| `saveMetadata` | `file.write` | Writes `invoice.json` — the agent's full structured reply. Reconciliation jobs can pick this up later without re-parsing the email. |
| `saveAttachments` | `file.write` | `batchOver: ${input.attachments}` — fans out, one write per attachment. `${item}` and `${index}` are exposed in the batch context. Email attachments come through as base64, so `encoding: "base64"` lets file.write decode before writing bytes. |

The whole workflow is forty lines of JSON. No glue code. No bash. No
"now write a small Python script that…". The trigger, the LLM call,
the batch fanout, and the typed file writes are all engine primitives.

## Customising

A few knobs people typically reach for:

- **Path layout.** Change `buildPath`'s expression. Common variants:
  by vendor first (`payments/<vendor>/<year>/<month>/`), or flat
  (`payments/<year>-<month>-<day>-<vendor>/`). Anything FEEL can build
  is fair game.
- **More than just invoices.** Add a second agent + guard chain
  alongside this one — maybe "is this a renewal reminder?" filing into
  `renewals/`. The mail trigger fires both; each branch decides
  independently.
- **Move the email itself, not just save the attachments.** Today the
  workflow archives to local disk and leaves the original message in
  the inbox. If you want IMAP-side filing, add a `shell.exec` call
  invoking your favourite IMAP CLI as the last step, or use the
  `workflow.fire` plugin to chain into a dedicated IMAP-archiving
  workflow.
- **Push to S3 / blob storage.** Swap `file.write` for `shell.exec`
  with `aws s3 cp`, or — if you've installed the SSH plugin — pipe
  the bytes over SFTP to a managed share. Both are ~5-line changes.

## Why this is worth showing off

Workflow tools that handle the mechanical bits — IMAP polling, file
I/O, retries — usually fall flat the moment you need a judgment call
in the middle. Workflow tools that handle judgment calls — pure
AI-agent frameworks — usually punt the boring bits ("save these bytes
to disk in a structured folder") back to you as glue code.

Daisy puts both in the same DAG. The agent is a node. The file write
is a node. Cascading skips on a single `executeIf`. Multi-attachment
fanout via one `batchOver` setting. Forty lines of JSON that would be
two hundred lines of Python with a cron job behind it.

That's the pitch. This sample is the cheapest way to see it work on
your own inbox in twelve minutes.

## Files

```
samples/auto-archive-invoices/
├── workflow.json    # the DAG — import this into Daisy
└── README.md        # you're reading it
```
