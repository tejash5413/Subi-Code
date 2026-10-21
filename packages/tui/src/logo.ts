export const logo = {
  left: [
    " ████ █   █ ████  █████",
    "█     █   █ █   █   █  ",
    " ███  █   █ ████    █  ",
    "    █ █   █ █   █   █  ",
    "████   ███  ████  █████",
  ],
  right: [
    " ████  ███  ████  █████",
    "█     █   █ █   █ █    ",
    "█     █   █ █   █ ████ ",
    "█     █   █ █   █ █    ",
    " ████  ███  ████  █████",
  ],
}

export const go = {
  left: ["       ", "  ▄▄▄  ", "  ███  ", "  ▀▀   "],
  right: ["       ", "  ▄▄▄  ", "  ███  ", "  ▀▀   "],
}

// A terminal character wordmark: ordinary terminal fonts remain user-controlled.
const lettering = {
  S: [" ████", "█    ", " ███ ", "    █", "████ "],
  u: ["     ", "█   █", "█   █", "█   █", " ████"],
  b: ["█    ", "█    ", "████ ", "█   █", "████ "],
  i: ["█", " ", "█", "█", "█"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  o: ["     ", " ███ ", "█   █", "█   █", " ███ "],
  d: ["    █", "    █", " ████", "█   █", " ████"],
  e: ["     ", " ███ ", "█████", "█    ", " ████"],
}
export const wordmark = Array.from({ length: 5 }, (_, row) =>
  (["S", "u", "b", "i", "C", "o", "d", "e"] as const).map((letter) => lettering[letter][row]).join(" "),
)
