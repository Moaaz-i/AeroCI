---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "AeroCI"
  text: "A local twin for GitHub Actions"
  tagline: Run, check, analyse and audit your workflows before you push — in an isolated copy of your project. Anything AeroCI cannot reproduce is reported as not simulated, never as a success it cannot vouch for.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: CLI Reference
      link: /cli-reference
    - theme: alt
      text: View on GitHub
      link: https://github.com/Moaaz-i/AeroCI

features:
  - icon: 🧪
    title: Isolation you can verify
    details: One real copy of the project per job and per matrix combination, so a file one job writes is invisible to the next. The test suite checks the leak by writing a file and looking for it outside, not by trusting a return value.
  - icon: 🧠
    title: Structural intelligence
    details: The job graph in dependency order, dead steps, duplicate steps, outputs nothing reads, redundant jobs, matrix expansion, and a complexity score with the penalties that produced it.
  - icon: 🛡️
    title: Security audit
    details: Template injection through untrusted context, script injection into the shell, missing or over-broad permissions, actions pinned to a mutable tag, pull_request_target plus checkout, and hardcoded credential patterns.
  - icon: 📌
    title: Honest about pinning
    details: Every action reference is classified as a SHA, a short SHA, a tag, a moving branch, a local action or a container image — and as simulated or not simulated. `aeroci versions --check-remote` asks the GitHub API, six lookups at a time.
  - icon: 📊
    title: Reports in four formats
    details: JSON, Markdown, HTML and JUnit XML, written under .aeroci-artifacts/report/. The JSON is the source of truth, and every other format is a re-render of it.
  - icon: 🧩
    title: A debug shell that matches
    details: "aeroci debug rebuilds the conditions of a failed step — the same sandbox, the same CI environment, real GITHUB_OUTPUT and friends — so the command can be re-run by hand and give the same answer."
---
