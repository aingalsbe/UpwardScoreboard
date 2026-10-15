# Sheets templates

Import order: courts.csv, then teams.csv, then schedule.csv (Admin > Import / Export).

Keep the id column when you edit the schedule. Download the schedule export, edit it in Google Sheets and re-import it with the id column still there. The id is how a game whose time, court or teams changed gets updated instead of added a second time. Leave id blank only for brand-new games, and do not reuse or retype ids.

A game that is not scheduled yet can have date and time both empty (court may be empty too).

home_score, away_score and status in an export are ignored on import.

Full column reference: section 10 of ../UpwardScoreboard-POC.md.
