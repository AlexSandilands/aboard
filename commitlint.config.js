export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Bodies often carry wrapped prose or file lists; don't fail on long lines.
    "body-max-line-length": [0],
  },
  // Dependabot's bodies carry release notes and a YAML footer that trip the footer rules. Its PR titles are
  // Conventional (.github/dependabot.yml) and CI lints the title, which is what lands on main.
  ignores: [(message) => message.includes("Signed-off-by: dependabot[bot]")],
};
