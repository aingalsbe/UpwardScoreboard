// Pure view helpers for the schedule screen (no DOM), shared with the unit tests.
/** "16:30" -> "4:30" (lobby style). */
export const t12 = (hm) => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`; };
/** home | away | tie for a complete game, else ''. */
export const winnerOf = (status, hs, as) => (status !== 'complete' ? '' : (hs ?? 0) > (as ?? 0) ? 'home' : (as ?? 0) > (hs ?? 0) ? 'away' : 'tie');
/** Status tag text: icon + word, never color alone. */
export function statusTag(state, winner, isNext, time) {
  if (state === 'complete') return winner === 'tie' ? '✓ FINAL · TIE' : '✓ FINAL';
  if (state === 'active') return '● LIVE';
  return isNext ? '🕒 UP NEXT' : `🕒 ${t12(time)}`;
}
/** Text for a day without games. */
export const emptyText = (isToday, dayLabel) => (isToday ? 'No games scheduled today' : `No games scheduled for ${dayLabel}`);
