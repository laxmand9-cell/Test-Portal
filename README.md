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

Needs **Node.js 22.13 or newer**. There's no separate database to install: everything is kept in one file, `data/portal.db`.

```
npm install
ADMIN_USER=admin ADMIN_PASSWORD=choose-a-strong-one npm start
```

Open http://localhost:3000 and log in as the central admin. Change the password under **Account**.

Settings (environment variables):

| Name | Meaning | Default |
|---|---|---|
| `PORT` | Web port | 3000 |
| `DATA_DIR` | Folder for the database file | `./data` |
| `ADMIN_USER`, `ADMIN_PASSWORD` | First central admin, created only when none exists | admin / change-me-now |

## Putting it online (Render)

This repository includes `render.yaml`, so Render fills in every setting itself.

1. On render.com choose **New > Blueprint** and pick this repository.
2. When asked, type `ADMIN_USER` and `ADMIN_PASSWORD`. These are the first central-team login.
3. Click **Apply**. Render creates the service with a 1 GB disk at `/var/data` on the Starter plan ($7/month + $0.25/GB).

The portal needs a disk to keep data. Without one (for example on the free plan) it still starts, but it shows the central team a red warning, and everything is erased on every restart or update.

Every push to the `main` branch updates the live site automatically.

To move to your own server later, copy the folder and the `portal.db` file, run `npm install`, then `npm start` behind a web server with HTTPS (nginx or Caddy).

**Backups:** copy `portal.db` regularly, for example a daily copy to Google Drive. That one file holds everything.

## Adding students from Excel

Under **Students**, choose **Import from Excel**. The columns are roll, name, zone, campus and batch, plus optional username and password. The zone, campus and batch names must match the portal.

The username defaults to the roll number. Empty passwords are generated, and the login list can be downloaded once right after the import.

## Files

- `server.js`: the server, database and permissions
- `public/app.js`, `public/style.css`, `public/index.html`: the website
- `public/vendor/omr_core.js`: OMR sheet layouts, reader and marking (shared by the server and browser)
- `public/vendor/sheet_render.js`: prints the sheets
- `public/vendor/*`: libraries (PDF, QR, ZIP, Excel), bundled so nothing is loaded from other sites
