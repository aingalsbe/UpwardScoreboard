# Upward 2027 real data (from Jessica's emails)

## Emails
- "Upward Game Schedule 2027" — 2026-10-21 4:18 PM CT (game CSV) and "RE: Upward Game Schedule 2027" — 4:21 PM CT (practice CSV)
- "Cheer Schedules" — 2026-10-27 7:46 AM CT (cheer game + practice CSVs)
Bodies are signature only. All attachments were already CSV (no PDF/XLSX); signature logo PNGs skipped.

## Files
- Upward Game Schedule 2027.csv (208 games), Upward Basketball Practice Schedule 2027.csv (468 rows)
- Cheer Game Schedule.csv (80 rows), Cheer Practice Schedule.csv (90 rows)
- basketball-raw.txt, cheer-raw.txt (body + CSVs), *-email-body.txt, analysis.txt (computed stats)

## Basketball — 7 divisions, 52 teams (names match the 7 expected divisions; all girls teams use "Lady " prefix)
- 1st-2nd Grade Boys: 12 teams: Knights (Heather Little); Lightning (Justin Pickens); Badgers (Karl Ploeger); Rangers (Brett Wood); Jaguars (Brad Ellis); Mustangs (Darren Hawkins); Bobcats (nan); Coyotes (David Fastnacht); Panthers (Christian Meyer); Grizzlies (Corbin Wheeler); Wolfpack (nan); Eagles (Kevin Juhl)
- 1st-2nd Grade Girls: 4 teams: Lady Hawks (Sean Harmon); Lady Hurricanes (Heather  Mitchell); Lady Lobos (Kelsey Kempin); Lady Terrapins (Kevin  Shell)
- 3rd-4th Grade Boys: 12 teams: Bulldogs (Ian Rothell); Cornhuskers (Deron Cherry); Longhorns (Wyatt Morgan); Tigers (David Swisher); Wildcats (Hayden Knight); Sooners (Jim Golightly); Tarheels (Paul Klingle); Jayhawks (Blake Hiestand); Raiders (nan); Buckeyes (nan); Wolverines (Jacob Albert); Aggies (Evan Belden)
- 3rd-4th Grade Girls: 6 teams: Lady Bearcats (Tami Crawshaw); Lady Sparks (Todd Bottorff); Lady Huskies (Dave MacLachlan); Lady Cardinals (Nathaniel Glidewell); Lady Clippers (Reagan Wittman); Lady Razorbacks (Jesse Kangas)
- 5th-6th Grade Boys: 8 teams: Raptors (Wyatt Morgan); Rockets (Brian Chiles); Bucks (Eric Offill); Bulls (Tyler Dodds); Jazz (Dennis Nighswonger); Warriors (Dave Owen); Lakers (Taylor Prince); Suns (Jesse Kangas)
- 5th-6th Grade Girls: 4 teams: Lady Gators (Mike Tilden); Lady Owls (Travis Daniel); Lady Monarchs (Kevin Juhl); Lady Fever (Brian Griffin)
- Kindergarten: 6 teams: Bears (Erin  Friesen); Cowboys (Nick Greenlee); Mavericks (Megan McLaughlin); Rams (Bryan Taylor); Spartans (Brian  Kempin); Lions (Tavis Hackathorn)

Coaches missing (blank): Bobcats, Wolfpack (1st-2nd B), Raiders, Buckeyes (3rd-4th B). Coaches on 2 teams: Wyatt Morgan (Longhorns, Raptors), Jesse Kangas (Lady Razorbacks, Suns), Kevin Juhl (Eagles, Lady Monarchs). Some names have double spaces (e.g. "Erin  Friesen") — trim/collapse.

### Game schedule
Columns: RoundNumber, TeamGroupNumber, Date, DivisionName, HomeTeam, AwayTeam, StartTime, EndTime, FacilityName, Home/AwayTeamHeadCoachName, GameReferees (always empty). One row per game.
- 8 rounds, 1/15/2027 – 3/6/2027; each round = Friday + Saturday (16 dates). Every team plays 8 games. Per division: 1-2B 48, 3-4B 48, 5-6B 32, K 24, 3-4G 24, 1-2G 16, 5-6G 16.
- Friday: 5:15/6:15/7:15/8:15 PM (60-min). Saturday: hourly 8 AM – 7 PM start.
- Courts: "Game Court - East", "Game Court - West", "Game Court - Full" (5th-6th grade games, Sat 2–8 PM). No double-booked slots.

### Basketball practices
Mon/Tue/Thu (+ some Wed), 9 weeks 1/4–3/4/2027, 5–9 PM hourly, courts WEST 1/2, EAST 1/2.

## Cheer — 4 grade bands, 10 squads
- 1st - 2nd Grade Girls: 4 squads: Shining Lights (Alivia Deweerd); Sparklers (Kathy  Wolfe); Faith Fusion (Hannah  Gorter); Grace United (Rachel Inloes)
- 3rd-4th Grade Girls: 3 squads: Cheer Angels (Penny Linduff); Spirit Squad (Amanda Russell); Firecrackers (Cara Middleton)
- 5th-6th Grade Girls: 1 squads: Momentum (Kristin Thomas)
- Kindergarten: 2 squads: Heavenly Halos (Suzie  Carson); Heavenly Hype (Bethany Morgan)
- No 1st-2nd/3rd-4th/5th-6th *Boys* cheer (expected). Division name in cheer files is "1st - 2nd Grade Girls" (spaces) vs basketball "1st-2nd Grade Girls" — normalize.
- Cheer games: one row per squad per Saturday, 8 weeks 1/16–3/6/2027, fixed hourly slot (K 8–9 AM, 1-2 10 AM–1 PM, 3-4 2–4 PM, Momentum 5 PM), all "Game Court - Full"; AwayTeamHeadCoachName empty. Squads aren't tied to a specific basketball game.
- Cheer practices: Mondays (Grace United on Thursdays), 9 weeks 1/4–3/4/2027, 6:00–7:00 PM (Spirit Squad 6:30–7:30), rooms: Room 28/30, 29/31, 22, 33/35, 20, Kids Street, Foundry.

## Ambiguities / problems
- 16 Friday 8:15 PM games end 9:15 PM — past a 9 PM limit.
- Saturday cheer at "Game Court - Full" overlaps basketball games on East/West courts at the same times (e.g. 10 AM Sparklers vs 1-2B games) and 5th-6th "Full" basketball games 2–7 PM overlap cheer 2–5 PM on "Game Court - Full" — the same facility name is double-booked if Full means the whole gym. Probably cheer performs at those games; confirm.
- Division names have trailing spaces ("3rd-4th Grade Boys ", "5th-6th Grade Girls "); "Room 22 " trailing space.
- Missing coaches (4 bball teams), no referees. Practice courts (WEST/EAST 1/2) differ from game court names.
