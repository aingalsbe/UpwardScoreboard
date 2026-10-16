# Sheets templates

Import order: courts.csv, then teams.csv, then schedule.csv (Admin > Import / Export).

Keep the id column when you edit the schedule. Download the schedule export, edit it in Google Sheets and re-import it with the id column still there. The id is how a game whose time, court or teams changed gets updated instead of added a second time. Leave id blank only for brand-new games, and do not reuse or retype ids.

Courts: the gym has one floor, used either as Full (slug full) or split into West (west) and East (east). West and East run at the same time; Full can't overlap either of them. In courts.csv, conflicts_with lists the courts a court can't overlap (full has "west east"). Leave the column empty for the half courts.

minutes (optional) is the game length. Leave it empty to use the default (GAME_MINUTES, 60). A Full game whose start time + length overlaps a West or East game (or the other way round) is reported as a row error naming the other game. Back-to-back is fine: a West game 10:00-11:00 then Full at 11:00.

A game that is not scheduled yet can have date and time both empty (court may be empty too).

Team names are unique within a grade: 2nd Grade Eagles and 5th Grade Eagles are two teams (see teams.csv). teams.csv matches on grade + name. In schedule.csv, fill the grade column when a team name exists in more than one grade; without it, a name used in one grade only is found automatically, and a name in several grades takes the other team's grade, otherwise the row is an error.

home_score and away_score are ignored on import. status is optional: a game that never started can be set to complete with its scores; other status changes are made in Admin.

Uploaded cheer logos are exported as the full address of the served file; re-importing keeps the upload.

Full column reference: section 10 of ../UpwardScoreboard-POC.md.
