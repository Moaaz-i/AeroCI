import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "AeroCI",
  description: "Local Digital Twin & CI Pipeline Simulator for GitHub Actions",
  ignoreDeadLinks: true,
  markdown: {
    vPre: true
  },
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/getting-started' },
      { text: 'CLI Reference', link: '/cli-reference' },
      { text: 'Configuration', link: '/configuration' },
      {
        text: 'Features',
        items: [
          { text: 'Workflow Analyzer', link: '/features/analyzer' },
          { text: 'Performance Profiler', link: '/features/profiler' },
          { text: 'Security Audit', link: '/features/security' },
          { text: 'Multi-Format Reports', link: '/features/reporter' },
          { text: 'Action Simulator', link: '/features/actions' }
        ]
      }
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'CLI Reference', link: '/cli-reference' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Sandbox & Isolation', link: '/sandbox' }
        ]
      },
      {
        text: 'Enterprise Features',
        items: [
          { text: 'Workflow Analyzer (1-10)', link: '/features/analyzer' },
          { text: 'Performance Profiler (11-20)', link: '/features/profiler' },
          { text: 'Security Audit (21-30)', link: '/features/security' },
          { text: 'Multi-Format Reports (31-40)', link: '/features/reporter' },
          { text: 'Action Simulator (41-50)', link: '/features/actions' }
        ]
      },
      {
        text: 'Community',
        items: [
          { text: 'Contributing', link: '/contributing' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Moaaz-i/AeroCI' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 AeroCI Team'
    },

    search: {
      provider: 'local'
    }
  }
})
