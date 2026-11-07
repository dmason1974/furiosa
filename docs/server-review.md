# Fury Road Server Review — New Player Experience

7 November 2026 · steampunk74

jj is right: a new player has no route from joining to playing. The rules content is good, but nothing tells newcomers how events work, where the next one is, or how to sign up. 40% of the channel links in #announcements now point at deleted channels.

## The new player's path

Almost everyone gets the War Boy role on joining (406 of 409 members have it), so access isn't the problem. The problem is that each step stops without saying what comes next.

1. **Join.** Discord onboarding and the welcome screen are both switched off, so the player lands on whatever channel is at the top. Right now that is #participant-roster, a list of last month's Kingslayer teams.
2. **Welcome message.** Carl-bot posts a greeting in #reception that links only #code-of-conduct and #announcements. It says nothing about events, how to sign up, or the rules for playing.
3. **#server-description.** This is a mission statement ("what we're about"). It has no practical information: what an event is, how often they run, or how to join one.
4. **#announcements.** The real information is here, mixed into 9 months of posters, winner write-ups, polls and 19 @everyone pings. 10 of the 26 channel links in it point at channels that no longer exist, including every "Register here" link.
5. **Finding the next event.** The current one, Fury Road x DTG, is a forum post in #upcoming-event. It lists six formats with different team sizes but gives no per-format dates and no way to register. One player has already asked in the thread whether these are separate events and what team they need. That question is the concrete example jj couldn't give.
6. **Learning the rules.** Rules live in four places: #code-of-conduct, #event-rules, #sanctions, and 14 one-message channels under *definitions*. Each event's poster then says which of those apply. A newcomer has to put these together alone.
7. **Raising a problem.** #support-tickets has a working ticket button. This step is clear.

## Findings

The biggest gaps are in getting started and finding events. Rules content is solid but scattered.

| Area | Issue | Evidence | Suggested fix |
| --- | --- | --- | --- |
| Getting started | No "start here" content anywhere | Onboarding off, no welcome screen; #server-description has no practical steps | One pinned #start-here post: what Fury Road runs, how a typical event works, where to look, how to sign up |
| Getting started | Welcome message points at the wrong things | Carl-bot greeting links only #code-of-conduct and #announcements | Point it at #start-here and #upcoming-event |
| Getting started | First channel a newcomer sees is stale | #participant-roster (Kingslayer, ended Oct 17) sits above every category, visible to everyone | Archive or hide it after each event |
| Finding events | Sign-up links break after every event | 10 of 26 channel links in #announcements are dead, including all "Register here" links | Keep one permanent #how-to-register (or #upcoming-event) and link that instead of per-event channels |
| Finding events | Each event signs up a different way | Kingslayer used an external roster bot (Manolo); staff applications used Appy; Furiosa has `/register` | Choose one sign-up method and use it for every event |
| Finding events | Upcoming post mixes six formats with no per-format detail | Fury Road x DTG: team sizes of 1, 2, 3 and 5, one date (Nov 21/22) for all six, no sign-up step, just a link to the DTG server | One forum post per format: dates, team size, how to join |
| Finding events | Discord's built-in Events feature is unused | 0 scheduled events on the server; event times are spread across posters as UTC, GMT and `<t:…>` timestamps | Create a Discord Event for each key moment: registration close, zone draw, game start, war start. Each shows at the top of the channel list, in every viewer's own time zone, and notifies anyone who clicked Interested |
| Finding events | Key rule changes buried in chat-style posts | "No more elite maps" (Sep 21) is one plain announcement and contradicts older posters | Put standing changes in #event-rules, not just announcements |
| Rules | Rules split across 17 channels | #code-of-conduct, #event-rules, #sanctions and 14 definition channels averaging about 360 characters each | One #rulebook with three sections: win conditions, violations, map terms. Furiosa's rules index already builds this per event |
| Rules | Definitions mix three kinds of term | Win conditions (3), violations (9) and map concepts (2) sit in one near-alphabetical list | Group by kind, with a one-line "what this means for you" for each |
| Rules | A few definitions are unclear or have typos | Market blocking ("moved there by 0.1 steps"); "boundy", "a paths", "Each team choose" | Light copy-edit |
| Announcements | Opt-in ping role is ignored | #pings-for-update offers an opt-in role (most likely Wastelanders, 36 members), yet #announcements has used @everyone 19 times | Use @everyone only for event launches; ping Wastelanders for everything else |
| Announcements | Same poster posted three times | Balance of Power on May 5, May 11 and May 19 | Edit the original and repost only if something changed |
| Housekeeping | Names out of date | "Thunderdome-general" is named after the first event; the *Events* category holds rules and tickets, not events | Rename to *Community* and *Rules & Support* |
| Housekeeping | Leftover channels | Two open ticket channels in *Events*; #balance-of-power-map01 in *Logs*; unused "event updates" role (0 members) | Close or delete them |

## Fix list, in priority order

The first five fix most of jj's complaint and take about an evening. None need new bots.

**Do first**

- [ ] Write a #start-here post, pinned at the top: what Fury Road is, how a typical event runs (announce → sign up → zone draw → truce → war), where each kind of information lives, and how to get pings.
- [ ] Change Carl-bot's welcome message to link #start-here and #upcoming-event.
- [ ] Hide or archive #participant-roster once each event ends.
- [ ] Split the Fury Road x DTG post into one post per format, each with dates, team size and how to sign up.
- [ ] Create Discord Events for each upcoming date (starting with Fury Road x DTG, Nov 21/22), with a link in each to how to sign up. Events don't replace registration: clicking Interested is not signing up.

**Next**

- [ ] Pick one sign-up method for all events and describe it in #start-here.
- [ ] Stop linking per-event channels from permanent posts. Link #upcoming-event or the event's forum post instead.
- [ ] Use @everyone only for event launches and results. For reminders, rely on Discord Events notifications and the opt-in role.
- [ ] Move standing rule changes (such as no elite maps) into #event-rules.

**When there's time**

- [ ] Merge the 14 definition channels into one #rulebook, grouped as win conditions, violations and map terms.
- [ ] Copy-edit the definitions and clarify market blocking.
- [ ] Rename *Thunderdome-general* and *Events*; close the leftover ticket and map channels; delete the unused "event updates" role.
- [ ] Consider switching on Discord's built-in Onboarding (the server is already a Community server), with a question such as "Want event pings?" in place of the reaction-role post.

## What already works

- **Code of conduct and strikes.** Clear, numbered, with a strike ladder that resets after 30 days.
- **#event-rules.** Sets out moderator authority, the dispute route and how sanctions work in plain terms.
- **#sanctions.** Each violation has a concrete resource cost, so penalties are predictable.
- **Definitions.** Short, specific, with screenshots for the map terms. The content is good; only the layout gets in the way.
- **Support tickets.** One button, one route for every dispute.
- **Event posters.** Each launch post covers map, team size, dates, rules and prizes. The trouble is that they stop working once the event's channels are deleted.

## Limits of this review

This is based on the server's channels, permissions, roles and the text of its info channels as of 7 Nov 2026, read through the Furiosa bot. It does not include images (posters, map graphics), chat channels, staff-only channels, or what new players have actually said. A few "where did you get stuck?" messages to recent joiners would confirm which fixes matter most.
