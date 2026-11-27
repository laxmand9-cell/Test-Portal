# Test Portal

A web portal for a multi-campus institute:

- **Central team** sees and manages everything: zones, campuses, batches, admins, students, question bank, tests.
- **Zone admins** see all campuses in their zone.
- **Campus admins** see their own campus.
- **Students** log in with the username and password the central team gives them, and see their published results.

Exams are written offline on OMR sheets. The portal prints a personalised sheet for every student, reads the scanned sheets, marks them against the answer key, and publishes the marks, ranks and question-wise review to each student's account.

## How a test runs

1. **Central team** creates the test: code, name, date, OMR sheet type and the batches writing it. They enter the answer key, or link questions from the question bank.
2. **Print sheets.** Any admin downloads a PDF of personalised sheets for their batches, in roll-number order.
3. **Students write the exam** on the sheets.
4. **Campus admin scans** the stack and drops the PDF, photos or a ZIP into **Upload scans**. Sheets are read in the browser. Doubtful marks are shown for a quick check, then **Save to portal** stores the answers.
5. **Results** fill in right away: marks, subject totals, ranks in batch, campus and overall, plus zone, campus and batch averages.
6. **Central team publishes.** Students then see their marks and review in their own account.

Changing the answer key later re-marks everyone automatically.

## Sheet types

JEE Main (full and physics), Classic JEE Main, JEE Advanced (full and physics), NEET (full and physics), Classic EAPCET 180, and Formula drill. Every sheet fits on one A4 page.

## Running it

Needs **Node.js 22**. Without `DATABASE_URL`, everything is kept in one file, `data/portal.db`, so nothing else needs installing.

```
npm install
ADMIN_USER=admin ADMIN_PASSWORD=choose-a-strong-one npm start
```

Open http://localhost:3000 and log in as the central admin. Change the password under **Account**.

Settings (environment variables):

| Name | Meaning | Default |
|---|---|---|
| `PORT` | Web port | 3000 |
| `DATABASE_URL` | PostgreSQL connection string (e.g. Neon). When set, data is stored there | not set |
| `DATA_DIR` | Folder for the database file when `DATABASE_URL` isn't set | `./data` |
| `ADMIN_USER`, `ADMIN_PASSWORD` | First central admin, created only when none exists | admin / change-me-now |

## Where the data is kept

- **`DATABASE_URL` set** (recommended online): everything is stored in PostgreSQL, for example a free **Neon** database. Data survives restarts and updates.
- **No `DATABASE_URL`**: everything is stored in one file, `portal.db`, in `DATA_DIR`. This is fine on your own computer or a server with a disk.

If neither can keep data (for example Render's free plan with no database), the portal still starts, but it shows the central team a red warning.

## Putting it online (Render)

`render.yaml` sets everything up: the Starter plan ($7/month) and a 1 GB disk at `/var/data` holding the database file ($0.25/month).

1. On render.com choose **New > Blueprint** and pick this repository.
2. Type `ADMIN_USER` and `ADMIN_PASSWORD` when asked, then click **Apply**.

To use PostgreSQL instead (Render Postgres or Neon), remove the disk and `DATA_DIR`, and set `DATABASE_URL`.

Every push to the `main` branch updates the live site automatically.

**Backups:** under **Account**, the central team can download a full backup (JSON for PostgreSQL, a `.db` file otherwise). Keep one every week.

## Adding students from Excel

Under **Students**, choose **Import from Excel**. The columns are roll, name, zone, campus and batch, plus optional username and password. The zone, campus and batch names must match the portal.

The username defaults to the roll number. Empty passwords are generated, and the login list can be downloaded once right after the import.

## Files

- `server.js`: the server, database and permissions
- `public/app.js`, `public/style.css`, `public/index.html`: the website
- `public/vendor/omr_core.js`: OMR sheet layouts, reader and marking (shared by the server and browser)
- `public/vendor/sheet_render.js`: prints the sheets
- `public/vendor/*`: libraries (PDF, QR, ZIP, Excel), bundled so nothing is loaded from other sites
