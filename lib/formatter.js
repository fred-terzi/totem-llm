/**
 * Formatting utilities for professional, modern CLI output using ANSI color codes.
 */

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  bright: "\x1b[1m",

  // Foreground colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Bright foreground colors
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

// Symbols
const symbols = {
  dot: "●",
  arrow: "→",
  check: "✓",
  cross: "✕",
  dash: "─",
  pipe: "│",
  corner: "└",
  tee: "├",
};

/**
 * Format text with color and styling
 * @param {string} text - Text to format
 * @param {string} color - Color key from colors object
 * @param {string} style - Optional style: 'bold', 'dim'
 * @returns {string}
 */
export function colorize(text, color = "white", style) {
  const colorCode = colors[color] || colors.white;
  const styleCode = style === "bold" ? colors.bold : style === "dim" ? colors.dim : "";
  return `${styleCode}${colorCode}${text}${colors.reset}`;
}

/**
 * Format a section header
 * @param {string} title - Header text
 * @returns {string}
 */
export function header(title) {
  const line = symbols.dash.repeat(70);
  return `\n${colorize(line, "cyan")}\n${colorize(title, "cyan", "bold")}\n${colorize(line, "cyan")}\n`;
}

/**
 * Format a status line with label and value
 * @param {string} label - Label text
 * @param {string} value - Value text
 * @param {string} valueColor - Color for value
 * @returns {string}
 */
export function statusLine(label, value, valueColor = "brightGreen") {
  const paddedLabel = label.padEnd(25);
  return `  ${colorize(paddedLabel, "gray")} ${colorize(value, valueColor)}\n`;
}

/**
 * Format a section with a title and items
 * @param {string} title - Section title
 * @param {string[]} items - Array of items to display
 * @returns {string}
 */
export function section(title, items = []) {
  let output = `\n${colorize(`${symbols.tee} ${title}`, "brightCyan", "bold")}\n`;
  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    const prefix = isLast ? symbols.corner : symbols.tee;
    output += `  ${colorize(prefix, "cyan")} ${item}\n`;
  });
  return output;
}

/**
 * Format a highlighted box around text
 * @param {string} text - Text to highlight
 * @param {string} color - Color for the box
 * @returns {string}
 */
export function highlightBox(text, color = "brightYellow") {
  const width = Math.max(text.split("\n").map((l) => l.length).reduce((a, b) => Math.max(a, b), 0)) + 4;
  const line = colorize(symbols.dash.repeat(width), color);
  const paddedText = text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

  return `\n${line}\n${colorize(paddedText, color, "bold")}\n${line}\n`;
}

/**
 * Format a clickable/highlighted URL
 * @param {string} url - The URL
 * @returns {string}
 */
export function urlStyle(url) {
  return colorize(url, "brightBlue", "bold");
}

/**
 * Format a success message with icon
 * @param {string} message - Message text
 * @returns {string}
 */
export function success(message) {
  return `${colorize(symbols.check, "brightGreen", "bold")} ${colorize(message, "brightGreen")}`;
}

/**
 * Format an info message with icon
 * @param {string} message - Message text
 * @returns {string}
 */
export function info(message) {
  return `${colorize(symbols.dot, "brightBlue")} ${colorize(message, "white")}`;
}

/**
 * Format a warning message
 * @param {string} message - Message text
 * @returns {string}
 */
export function warning(message) {
  return `${colorize(symbols.cross, "brightYellow")} ${colorize(message, "brightYellow")}`;
}

/**
 * Format an error message
 * @param {string} message - Message text
 * @returns {string}
 */
export function error(message) {
  return `${colorize(symbols.cross, "brightRed")} ${colorize(message, "brightRed")}`;
}

/**
 * Create a formatted table row
 * @param {string[]} cells - Array of cell contents
 * @param {number[]} widths - Array of column widths
 * @returns {string}
 */
export function tableRow(cells, widths) {
  return cells
    .map((cell, i) => {
      const width = widths[i] || 20;
      return String(cell).padEnd(width);
    })
    .join(" ");
}

/**
 * Format application startup banner
 * @param {string} version - App version
 * @param {string} environment - Environment name
 * @returns {string}
 */
export function startupBanner(version, environment) {
  const banner = `
████████╗ ██████╗ ████████╗███████╗███╗   ███╗    ██╗     ██╗     ███╗   ███╗
╚══██╔══╝██╔═══██╗╚══██╔══╝██╔════╝████╗ ████║    ██║     ██║     ████╗ ████║
   ██║   ██║   ██║   ██║   █████╗  ██╔████╔██║    ██║     ██║     ██╔████╔██║
   ██║   ██║   ██║   ██║   ██╔══╝  ██║╚██╔╝██║    ██║     ██║     ██║╚██╔╝██║
   ██║   ╚██████╔╝   ██║   ███████╗██║ ╚═╝ ██║    ███████╗███████╗██║ ╚═╝ ██║
   ╚═╝    ╚═════╝    ╚═╝   ╚══════╝╚═╝     ╚═╝    ╚══════╝╚══════╝╚═╝     ╚═╝
  `;

  return (
    colorize(banner, "cyan") +
    `\n  ${colorize("Your Private AI", "brightCyan", "bold")}\n` +
    `  ${colorize("v" + version, "dim")}\n` +
    (environment ? `  Environment: ${colorize(environment, "yellow")}\n` : "") +
    "\n"
  );
}

/**
 * Format a divider line
 * @param {string} color - Color for the divider
 * @returns {string}
 */
export function divider(color = "cyan") {
  return colorize(symbols.dash.repeat(80), color) + "\n";
}

export { colors, symbols };
