<p align="center">
  <img src="./logo.png" alt="Waxon" width="360" />
  <br />
  <!-- repo-tagline:start -->
  <strong>🧠 Build knowledge and keep it 🔁</strong>
  <!-- repo-tagline:end -->
</p>

<p align="center">
  <a href="https://github.com/tsilva/waxon/actions/workflows/ci.yml"><img src="https://github.com/tsilva/waxon/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/tsilva/waxon/blob/main/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522.5.0-blue" alt="Node.js 22.5.0 or newer" /></a>
</p>

Waxon helps you remember what you study. Keep a private bank of questions and
answer from memory in your own words. Feedback and recall history determine
when each question comes up for review again.

## Try it

Open [Waxon](https://waxon.tsilva.eu), sign in, and add a question and answer
standard in **Library**. Open **Review** to answer due questions and read the
feedback. You can correct an evaluation from the review flow.

- [Local development](docs/local-development.md) covers installation,
  database setup, and checks. Existing legacy databases require the
  [separate reset procedure](docs/local-development.md#legacy-database-reset).
- [Agent access](docs/agent-access.md) covers searching and adding questions
  through MCP.
- [Question quality](reference/question-quality.md) explains how to write
  a question and answer standard.
- [Production delivery](docs/production-delivery.md) covers deployment.

## License

[MIT License](LICENSE).
