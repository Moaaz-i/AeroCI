import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "AeroCI",
  description: "Run, check, analyse and audit your GitHub Actions workflows locally",
  base: '/AeroCI/',
  markdown: {
    vPre: true
  },
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/getting-started' },
      { text: 'CLI Reference', link: '/cli-reference' },
      { text: 'Configuration', link: '/configuration' },
      {
        text: 'Details',
        items: [
          { text: 'Sandbox & Isolation', link: '/sandbox' },
          { text: 'Network policy', link: '/features/network' },
          { text: 'Action support', link: '/features/actions' }
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
        text: 'In depth',
        items: [
          { text: 'Action support', link: '/features/actions' },
          { text: 'Network policy', link: '/features/network' },
          { text: 'Workflow analyzer', link: '/features/analyzer' },
          { text: 'Profiler', link: '/features/profiler' },
          { text: 'Security audit', link: '/features/security' },
          { text: 'Reports', link: '/features/reporter' }
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
