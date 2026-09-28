/** When a message budget resets, as a time today or a weekday and time. */
export function resetTime(iso: string) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
