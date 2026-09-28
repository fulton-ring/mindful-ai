/** The Walden mark. `public/favicon.svg` draws the same paths for the browser tab. */
export function WaldenMark() {
  return (
    <svg viewBox="8 8 84 84" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="6"
        transform="rotate(-90 50 50)"
      >
        <path d="M18 36 C25 22 37 16 51 17 C68 16 82 28 84 45 C88 62 76 79 59 83 C42 88 27 79 21 66" />
        <path d="M34 39 C39 32 45 30 52 31 C64 31 70 40 70 51 C69 62 60 69 49 68 C42 68 37 64 34 59" />
      </g>
      <path
        d="M48 48 C50 46 53 47 54 50 C54 53 52 54 49 54 C46 53 46 50 48 48Z"
        fill="currentColor"
        transform="rotate(-90 50 50)"
      />
    </svg>
  );
}
