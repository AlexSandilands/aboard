export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Bodies often carry wrapped prose or file lists; don't fail on long lines.
    "body-max-line-length": [0],
  },
};
