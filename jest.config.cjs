module.exports = {
  roots: ["<rootDir>"],
  testMatch: [
    "**/__tests__/**/*.test.[jt]s",
    "**/*.test.[jt]s",
  ],

  // Resolve deps from all sub-packages
  moduleDirectories: [
    "node_modules",
    "<rootDir>/server/node_modules",
    "<rootDir>/collector/node_modules",
  ],

  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/",
    "/coverage/",
    "\\.config\\.[jt]s$",
    "\\/scripts\\/",
    "\\/prisma\\/",
    "\\/swagger\\/",
    "\\/frontend\\/",
  ],
  coverageThreshold: {
    global: {
      branches: 10,
      functions: 10,
      lines: 10,
      statements: 10,
    },
  },

  transform: {
    "^.+\\.[jt]s$": "babel-jest",
  },

  // Allow uuid v9 (pure ESM) to be transformed
  transformIgnorePatterns: [
    "/node_modules/(?!(uuid|strip-ansi|ansi-regex|@aws-sdk)/)",
  ],

  testEnvironment: "node",
};
