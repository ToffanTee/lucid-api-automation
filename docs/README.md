# Lucid API Automation

Postman/Newman test suite covering Lucid's customer-service APIs: onboarding
& activation, account, transfers, bills-payment, and card.

This suite is **split into five independently-runnable Postman
collections**, one per domain. Each collection can be run entirely on its
own — no collection depends on another having run first in the same
session. See "Why split by domain" below for the reasoning and the tradeoff
that comes with it.

## Structure

```
api-testing/
├── collections/
│   ├── Onboarding&Activation.postman_collection.json    # onboarding + new-user login + activation
│   ├── Account.postman_collection.json       # login (existing user) + account
│   ├── Transfers.postman_collection.json     # login (existing user) + transferv1
│   ├── BillsPayment.postman_collection.json  # login (existing user) + bills-payment
│   └── Card.postman_collection.json          # login (existing user) + card
├── shared-scripts/
│   ├── decrypt-encrypt.event.json            # canonical collection-level scripts
│   ├── existing-user-login.folder.json       # canonical login folder
│   └── accounts-retrieve-all.folder.json     # canonical account-fetch folder
├── scripts/
│   ├── build-manifest.json                   # what goes where
│   └── build-collections.js                  # injects shared-scripts/ into collections/
├── environments/
│   ├── Dev.postman_environment.json
│   ├── QA.postman_environment.json   # stub — needs real QA URLs/credentials
│   └── UAT.postman_environment.json  # stub — needs real UAT URLs/credentials
├── globals/
│   └── globals.postman_globals.json  # currently empty — see note below
├── docs/
│   └── README.md                     # you are here
├── package.json
└── .gitignore
```

## Prerequisites

- Node.js (v18+ recommended)
- `npm install` from the `api-testing/` root — installs Newman and the
  HTML report generator as dev dependencies.

## Running tests

```bash
npm run test              # all five collections, in sequence, against Dev
npm run test:onboarding   # just Onboarding & Activation
npm run test:account      # just Account
npm run test:transfers    # just Transfers
npm run test:bills        # just Bills Payment
npm run test:card         # just Card

# same, against QA
npm run test:onboarding:qa
npm run test:account:qa
npm run test:transfers:qa
npm run test:bills:qa
npm run test:card:qa
```

Each run writes an HTML report to `reports/` (git-ignored — see
`.gitignore`). CLI output prints inline as well. There's no combined
`test:qa`/`test:uat` "run everything" script yet — add one to `package.json`
following the same pattern as `test:all` if you want it.

To run a collection against UAT, or with a different flag combination than
what's in `package.json`, invoke Newman directly, e.g.:

```bash
newman run collections/Card.postman_collection.json \
  -e environments/UAT.postman_environment.json
```


## Domain overview

| Collection | Contains | Login |Notes |
|---|---|---|---|
| `Onboarding&Activation.postman_collection.json` | `onboarding` (BVN/email OTP verification, user invite), `authentication` (login), `activation` (activation progress) | Uses the **newly-registered user** created by `onboarding` — that's the whole point of this collection, it can't use an existing-user login instead | These three folders are a strict sequential chain, not three independent domains — see note below |
| `Account.postman_collection.json` | `account` (customer account retrieval, transaction history) | Embedded `authentication` folder, **existing user** (reused from the original `authentication Copy`) | Runs standalone |
| `Transfers.postman_collection.json` | `transferv1` (inter-bank and intra-bank transfers, each in three variants: immediate, later, recurring) | Embedded `authentication` folder, existing user | See "Transfer flow order" below — this is the most script-heavy collection. Runs standalone |
| `BillsPayment.postman_collection.json` | `bills-payment` (airtime and data bill payments, same three variants) | Embedded `authentication` folder, existing user | Mirrors the transferv1 later/recurring pattern. Each of its six sub-folders now starts with its own `accounts retrieve-all` step too (matching `transferv1`), so `senderAccountNumber` gets fetched fresh instead of relying on `Transfers` having run first. Runs standalone |
| `Card.postman_collection.json` | `card` (card configuration retrieval, card request) | Embedded `authentication` folder, existing user | Runs standalone |

All five folder structures (and the requests inside them) are otherwise
unchanged from before the split — same URLs (`{{customer_service_base_url}}`,
`{{transfer_service_base_url}}`, `{{vas_service_base_url}}`,
`{{card_service_base_url}}`), same scripts, same variable names.

**Why `Onboarding&Activation.postman_collection.json` isn't split further:** `onboarding`,
`authentication`, and `activation` aren't independent domains — `activation`
acts on the user that `authentication` just logged in, which is the same
user `onboarding` just created. Splitting them into three separate
collections wouldn't make them independently runnable, it would just hide
the dependency.

**Why the other four embed their own login step:** `Account`, `Transfers`,
`BillsPayment`, and `Card` all need a valid `{{bearerToken}}` (the
collection-level `auth` block on every one of these collections is
`bearer: {{bearerToken}}`). Rather than requiring `Onboarding`'s
new-user login to have run first in the same environment, each of these
four collections has its own copy of the **existing-user** login folder
(originally `authentication Copy`, renamed to plain `authentication` within
each collection since it's the only auth folder there) at the top of its
own folder list. Run any one of these four on a clean environment and it
authenticates itself before doing anything domain-specific.

## How the encryption works

Every response body arrives encrypted. The **collection-level pre-request
and test scripts** (visible on each collection's root, not on individual
requests) handle AES-128-CBC decryption automatically:

- Pre-request: resolves `{{variables}}` in the outgoing body via
  `pm.variables.replaceIn()` and encrypts it before sending.
- Test (post-response): decrypts the response and stores the plaintext in
  the environment variable `DECRYPTED_RESPONSE` (string) and
  `DECRYPTED_RESPONSE_JSON` (pretty-printed, for the Postman UI).

Every request's own test script starts by reading `DECRYPTED_RESPONSE` and
`JSON.parse`-ing it — that's why you'll see the same first few lines
repeated at the top of nearly every test script in every collection.

**This script is duplicated five times** — once per collection, since a
Postman collection-level script can't be shared across separate collection
files at runtime. The canonical version lives at
`shared-scripts/decrypt-encrypt.event.json`; the five copies inside
`collections/*.postman_collection.json` are generated from it. **Don't edit
the script inside a collection file (in Postman's GUI or otherwise) — edit
`shared-scripts/decrypt-encrypt.event.json` and run `npm run build`.** See
"Keeping shared scripts in sync" below for the full workflow.

**This also has one important consequence for script order within a single
collection:** Postman always runs pre-request scripts in the order
*collection → folder → request*, right before send. That means the
collection-level script encrypts the body **before** a request's own
pre-request script gets a chance to run. Any variable that a request's own
pre-request script tries to set will only take effect on the *next* run,
not the current one.

The pattern used throughout every collection to work around that: anything
a request needs computed fresh (scheduling dates, recurring flags,
flow-specific type values) is set in an **earlier step's post-response
(test) script** in the same folder — typically `accounts retrieve-all`,
`institutions`, or `send-code` — rather than in the final request's own
pre-request script. If you add a new request that needs a freshly computed
variable, follow this pattern: compute it one step earlier, not in the
request's own pre-request script.

## Transfer flow order

Each of the six `transferv1` sub-folders (and the six `bills-payment`
sub-folders) is a **linear chain** — later steps depend on variables set
by earlier ones in the same folder. Run them top to bottom:

```
accounts retrieve-all → institutions → inquiry → validate-pin → send-code → request       (transferv1)
accounts retrieve-all → categories → payment-items → validate-pin → send-code → pay       (bills-payment)
```

Running Collection Runner top-to-bottom through a whole folder handles
this automatically. Running steps out of order, or a single step in
isolation without the earlier ones having run first in that session, will
send stale or unresolved data.

This also applies to the embedded `authentication` folder at the top of
`Transfers.postman_collection.json` and `BillsPayment.postman_collection.json`
— it needs to run before any `transferv1`/`bills-payment` request in the
same session, for the same reason: `{{bearerToken}}` has to exist before
the collection-level `auth` block can attach it to a request.

## Environment variables — what's real config vs. runtime scratch data

Most values in the environment files fall into one of three buckets:

1. **Genuine static config** — base URLs, `transferChannel`, `spendCategory`,
   `transferDescription`, etc. Safe to hand-edit and the same for every run.
2. **Flow-dependent values that must be script-set, not static** —
   `transferType`/`intraTransferType` is the clearest example: three
   `transferv1` folders need `INTER_BANK` and three need `INTRA_BANK`. A
   single static environment value can only ever be correct for one side,
   so these are set by script (in `institutions`' test script) right
   before each folder needs them. **If a new "same-named variable, different
   correct value per folder" situation comes up, it needs the same
   treatment — don't just add it as a static environment default.**
3. **Runtime-chained scratch values** — `senderAccountNumber`,
   `pinValidatedCode`, `deviceRegistrationCode`, the various
   `interBank*`/`intraBank*`/`airtime*`/`data*` recurring/date fields,
   `cardBin`, etc. These get overwritten by scripts every run. Whatever
   value currently sits in the committed environment file is just a seed
   left over from the last time someone ran the suite — don't treat it as
   meaningful, and don't manually "fix" it if it looks stale.

`bearerToken` and `DECRYPTED_RESPONSE`/`DECRYPTED_RESPONSE_JSON` are
intentionally blanked out in the committed environment files — the first
is a live auth token (shouldn't live in git even for a test environment),
the other two are scratch output from whatever the last response happened
to be. Both get populated by scripts on the next run.

## Globals

`globals/globals.postman_globals.json` is currently empty. Nothing in this
suite needs a value that's identical across *every* environment
(Dev/QA/UAT) — base URLs and credentials all vary by environment, and
everything else is either environment-specific or script-chained. Add
something here only if you find a genuine environment-independent
constant; otherwise it's fine to leave empty or drop the folder entirely.

## QA / UAT environments

`environments/QA.postman_environment.json` and
`environments/UAT.postman_environment.json` are currently **copies of
Dev** with just the display name changed — they exist as a starting
scaffold, not real environments. Before running against QA or UAT, update
the four `*_service_base_url` values and the login credentials
(`loginUsername`, `loginEmail`, `loginPassword`, `authenticationType`) to
match those environments.

## Why split by domain

Splitting into one collection per domain trades a maintenance cost for two
real benefits:

- **Each collection is genuinely independently runnable.** `Account`,
  `Transfers`, `BillsPayment`, and `Card` each carry their own login step,
  so none of them require another collection to have run first in the same
  environment/session.
- Smaller diffs and fewer merge conflicts once more than one person is
  editing this repo, and CI can run domains in parallel instead of one long
  sequential suite.

**The cost:** three pieces of content are duplicated across multiple
collection files, because Postman collection-level scripts and folder
structures can't be shared across separate collection files at runtime:

- The decryption/encryption script — 5 copies (one per collection)
- The existing-user login block — 4 copies (`Account`, `Transfers`,
  `BillsPayment`, `Card`) — plus a different, new-user variant in
  `Onboarding` that must never be confused with these 4
- The `accounts retrieve-all` block — 12 copies (6 `transferv1` sub-folders
  in `Transfers`, 6 `bills-payment` sub-folders in `BillsPayment`)

`scripts/build-collections.js` (see "Keeping shared scripts in sync" below)
exists specifically to stop this duplication from being a hand-maintained
liability — there's a single canonical source for each of the three, and
the copies are generated, not maintained independently. The tradeoff that
remains even with the tooling: you have to remember to edit the canonical
source and run the build, rather than editing directly in Postman — see
below for exactly what that means day to day.

## Keeping shared scripts in sync

Three things are duplicated across collection files (see "Why split by
domain" above), and each has exactly one canonical source of truth under
`shared-scripts/`:

| Canonical source | Injected into | Where |
|---|---|---|
| `shared-scripts/decrypt-encrypt.event.json` | Onboarding & Activation, Account, Transfers, BillsPayment, Card | Collection root `event` |
| `shared-scripts/existing-user-login.folder.json` | Account, Transfers, BillsPayment, Card (**not** Onboarding) | The `authentication` folder |
| `shared-scripts/accounts-retrieve-all.folder.json` | Every `transferv1` sub-folder (Transfers), every `bills-payment` sub-folder (BillsPayment) | The `accounts retrieve-all` folder, wherever it appears |

`scripts/build-manifest.json` is the config that maps each source to its
targets — that's what to edit if you add a new collection that also needs
one of these three blocks, or need to change which collections a block
applies to.

### The rule

**Never edit a canonical block inside a `collections/*.postman_collection.json`
file directly — not by hand, and not through the Postman GUI.** Edit the
matching file in `shared-scripts/` instead, then run the build. If you
edit inside Postman and export, your change only exists in that one file;
the next `npm run build` will silently overwrite it back to whatever
`shared-scripts/` still says.

### Day-to-day workflow

**Changing one of the three shared blocks** (e.g. fixing a bug in the
decryption logic, adding a field to the login flow, changing how
`accounts retrieve-all` computes something):

1. Edit the relevant file under `shared-scripts/` directly as JSON — these
   are plain Postman item/event fragments, so it's easiest to make the
   change in Postman first (in *any one* of the collections that has that
   block), export that one collection, and copy the updated fragment back
   into the matching `shared-scripts/*.json` file. Or edit the JSON by
   hand if the change is small.
2. Run `npm run build`. This overwrites every collection file that target
   applies to with the new canonical content.
3. Run `npm run verify` to confirm everything's now in sync (should exit
   0, "All collections are in sync").
4. Re-import the changed `collections/*.postman_collection.json` files
   into Postman if you had them open, so your workspace picks up the
   regenerated version.
5. Commit both the `shared-scripts/` change and the regenerated
   `collections/` files together.

**Adding a brand-new domain** (a new collection file):

1. Build it in Postman as normal — new folder, new requests, whatever the
   domain needs. This part is unaffected by any of this tooling.
2. If the new collection needs to decrypt responses, add its name to the
   `"collections"` array of the `collection-event` target in
   `scripts/build-manifest.json`.
3. If it needs to authenticate independently, add its name to the
   `existing-user-login` target's `"collections"` array. (Make sure the
   collection has *some* folder named `authentication` for the build
   script to replace — even an empty placeholder folder works, since the
   whole folder gets overwritten.)
4. If it needs `senderAccountNumber` fetched fresh, make sure it has a
   folder named `accounts retrieve-all` wherever it's needed, and add the
   collection's name to that target's `"collections"` array.
5. Run `npm run build`, then `npm run verify` to confirm.

**Just editing a normal request or test assertion** (not one of the three
shared blocks): no special workflow — edit in Postman, export, overwrite
the file, commit. The build script only touches the specific blocks it's
configured to manage.

### Catching drift

`npm run verify` runs the same logic as `npm run build` but only checks —
it writes nothing, and exits with a non-zero status if any collection is
out of sync with `shared-scripts/`. Worth running before every commit, or
wiring into CI / a pre-commit hook, so an accidental GUI edit to a shared
block gets caught immediately instead of silently drifting.
