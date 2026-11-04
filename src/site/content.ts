// ALL the words on the public site (home page and Products page) live in this one file. Change a string here and the site changes.
// Keep the quotes and commas as they are. Lines marked PLACEHOLDER are stand-in values waiting for real ones.
// Copy rules: no blockchain wording, no real-payment wording, never claim "nobody records intent"
// (Verifiable Intent, AP2, Visa TAP and others exist). Say what AgentReceipt does: a merchant-side check and record.

export type FaqLine = { t: string; to?: string; toLabel?: string }

export const content = {
  brand: 'Agent Proceed',

  nav: {
    links: [
      { label: 'How it works', hash: 'how-it-works' },
      { label: 'Products', to: '/products' },
      { label: 'FAQ', hash: 'faq' },
      { label: 'Pilot', hash: 'pilot' },
      { label: 'Hackathon', to: '/hackathon' },
    ] as { label: string; hash?: string; to?: string }[],
    loginLabel: 'Login for demo',
    loginTo: '/dashboard', // the merchant dashboard has its own one-tap demo sign-in
  },

  hero: {
    // Headline = before + (emphasis, shown in teal) + after. The Agent Proceed tagline.
    eyebrow: 'Agent Proceed',
    headlineBefore: 'Everything merchants need to sell confidently when the shopper is an ',
    headlineEmphasis: 'AI agent',
    headlineAfter: '.',
    // The four tools, shown under the hero copy. Each links to its section on the Products page.
    tools: [
      { name: 'Agent Receipt', to: '/products#order-check' },
      { name: 'Listing Optimizer + Read as Agent', to: '/products#listing-optimizer' },
      { name: 'Evidence Packet', to: '/products#evidence-pack' },
      { name: 'Agent Activity tracker', to: '/products#agent-activity' },
    ],
    // The animated scene on the left of the hero (decorative; described for screen readers).
    sceneLabel: 'Three AI agents, each connected by a line to a merchant shop.',
    body: 'As your customers are changing from humans to agents, we help you in that transition with the tools you need to run your business successfully.',
    primaryCta: 'Login for demo',
    secondaryCta: 'See how it works',
    // The tilted sample receipt on the right (example values) and the two badge tags laid over it.
    card: {
      orderLabel: 'ORDER',
      orderNumber: '08.142',
      badge: 'Review required',
      grantTitle: 'Grant · customer authorized',
      grantRows: [
        { label: 'Order total', value: '$180.00 max', flag: false },
        { label: 'Delivery', value: 'Standard', flag: false },
        { label: 'Returns', value: '30 days', flag: false },
      ],
      actionTitle: 'Action · agent ordered',
      actionRows: [
        { label: 'Order total', value: '$212.40', flag: true },
        { label: 'Delivery', value: 'Expedited', flag: true },
      ],
      footnote: 'Mismatch facts · not a liability decision',
      sideNote: 'not a verdict.',
    },
    tags: [
      { merchant: 'Merchant 1 not using Agent Proceed', outcome: 'Order Fulfilled, Chargeback Received', tone: 'bad' },
      { merchant: 'Merchant 2 using Agent Proceed', outcome: 'Order Held and Confirmed, Chargeback Prevented', tone: 'good' },
    ] as { merchant: string; outcome: string; tone: 'good' | 'bad' }[],
  },

  // Right after the hero: four one-line problems, each tagged with the feature that solves it (links to its entry below).
  problem: {
    eyebrow: 'The problem',
    headline: 'AI agents are the new shoppers. Merchants are flying blind.',
    intro: 'Payment networks and banks solved trust for shoppers. Merchants are still left without tools.',
    blocks: [
      { problem: 'Listings agents cannot read.', tag: 'Solved by Agent Optimize', to: '#feature-listing-optimizer' },
      { problem: 'Orders merchants cannot verify.', tag: 'Solved by Agent Receipt', to: '#feature-agent-receipt' },
      { problem: 'Disputes with no playbook.', tag: 'Solved by Agent Dispute', to: '#feature-evidence-packet' },
      { problem: 'No view of what agents are doing in their store.', tag: 'Solved by Agent Activity', to: '#feature-agent-activity' },
    ],
  },

  whatWeDo: {
    eyebrow: 'A practical trust partner',
    headline: 'What we do for you',
    cards: [
      {
        icon: 'shield',
        anchor: 'feature-agent-receipt',
        tag: 'Agent Receipt',
        title: 'Catch it before you ship',
        body: "Agent orders are checked at order received, before fulfillment. If the order doesn't match what the customer authorized — budget, returns, delivery, size — it's flagged Review Required or Hold for Suspicion, and you hold shipment until you review it.",
      },
      {
        icon: 'package',
        anchor: 'feature-listing-optimizer',
        tag: 'Listing Optimizer + Read as Agent',
        title: 'Improve it',
        body: 'The agent audits your listings and suggests ways to structure listing for agents shopping on customer behalf to be able to read and interpret correctly.',
      },
      {
        icon: 'fingerprint',
        anchor: 'feature-evidence-packet',
        tag: 'Evidence Packet',
        title: 'Prove it if it disputes anyway',
        body: 'Every order gets an immutable record of intent and auth, hash-sealed, that you can download in one click as a chargeback representation package. Show grant vs action vs receipt, represent with proof, or concede early and save the chargeback fee.',
      },
      {
        icon: 'bot',
        anchor: 'feature-agent-activity',
        tag: 'Agent Activity tracker',
        title: 'See every agent in your store.',
        body: 'The Agent Activity map shows every agent session at its pipeline stage: session opened, grant recorded, proposal presented, order placed or verdict issued. Each bot icon is a real session record, with a verdict badge for its receipt. Icons move only when a stored record changes, and the map refreshes every 20 seconds.',
        image: { src: '/features/agent-activity-map.jpg', alt: 'The Agent Activity map in the merchant dashboard: a stylized store with seven agent sessions at the checkout line, each with a verdict badge, labelled as simulated agent traffic for Northwind Outfitters.' },
        cta: { label: 'See it in the dashboard', to: '/dashboard' },
      },
    ] as { icon: string; anchor: string; tag: string; title: string; body: string; image?: { src: string; alt: string }; cta?: { label: string; to: string } }[],
  },

  steps: {
    id: 'how-it-works',
    eyebrow: 'How it works',
    headlineLines: ['Grant.', 'Action.'],
    headlineEmphasis: 'Verdict.',
    // Right-hand lines. The big Grant. Action. Verdict. headline stays on the left.
    items: [
      { num: '01', text: 'What the customer told the agent', icon: 'fingerprint' },
      { num: '02', text: 'What the agent actually ordered', icon: 'package' },
      { num: '03', text: 'Ship, Review required or Hold decision', icon: 'shield' },
    ],
    note: 'Agent Receipt returns a signal, it does not block checkout itself — your order system holds shipment based on that signal. It shows mismatch facts only, it does not decide liability.',
  },

  // Home page Products block: exactly four tools. The long explanations are on the Products page (below).
  productsHome: {
    id: 'products',
    eyebrow: 'Products',
    headline: 'Four tools. One record.',
    moreLabel: 'See all products',
    moreTo: '/products',
  },

  // The Products page (/products): exactly four products, two paragraphs each.
  products: {
    eyebrow: 'Products',
    headline: 'Four products, one record.',
    intro: 'Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent. Agent Receipt checks orders before you ship, Listing Optimizer + Read as Agent make sure agents read your listings correctly, Evidence Packet proves it if it disputes anyway, and the Agent Activity tracker shows every agent in your store.',
    items: [
      {
        id: 'order-check',
        icon: 'shield',
        title: 'Agent Receipt',
        short: 'Catches mismatches before fulfillment.',
        paras: [
          "Agent orders are checked at order received, before fulfillment, against what the customer actually authorized — budget including shipping, returns, delivery date, size, and product scope. If the agent's order doesn't match, it's flagged Review Required when the record is trustworthy but a field mismatches, or Hold for Suspicion when the record itself can't be trusted.",
          "This is the checkpoint merchants are missing today. Existing fraud tools check card fraud, not authorization mismatch, and intent protocols alone give you an authorization, not a verdict. Catching the mismatch before you ship prevents the dispute, the return, and the chargeback fee — instead of finding out about it after the product has left your warehouse.",
        ],
      },
      {
        id: 'listing-optimizer',
        icon: 'package',
        title: 'Listing Optimizer + Read as Agent',
        short: 'Listing fixes from mismatch data and agentic-retrieval gaps, merchant-approved only.',
        paras: [
          'Listing Optimizer reviews every listing and provides a summary of what\'s missing for an agent to view it — details, metadata, and terms in a form agents can parse, filter, and compare without friction. Listings without details and metadata are skipped by agents, even if a human shopper would see them. Read as Agent shows how a shopping agent reads each listing as shoppers see it, without your formal terms.',
          'Fixing those gaps does two things: it prevents mismatches like a page that says "Easy returns" while formal terms are Final Sale, or a total including expedited shipping that isn\'t shown before confirmation, and it helps agents find and understand more of your catalogue, so fewer listings are skipped and chances of conversion increase. These are recommendations only, and the merchant approves every fix — Agent Proceed never auto-edits a product page, price, or terms on its own.',
        ],
      },
      {
        id: 'evidence-pack',
        icon: 'fingerprint',
        title: 'Evidence Packet',
        short: 'A downloadable Evidence Packet for a disputed shipped order.',
        paras: [
          'For a separate shipped order that later disputes, the immutable record of intent and auth — grant, action, formal terms, and hash-chained receipt, stored as fields only with no full customer chat — is transformed in one click into a downloadable chargeback representation package. It maps grant, action, receipt chain, and verdict to compelling-evidence fields.',
          "That saves the merchant from fighting blind or conceding by default. With grant vs action vs receipt in one pack, you can represent with proof when the order was authorized, or concede early and save the chargeback fee when the evidence doesn't support it — instead of spending manual review time assembling evidence order by order.",
        ],
      },
      {
        id: 'agent-activity',
        icon: 'bot',
        title: 'Agent Activity tracker',
        short: 'See every agent in your store.',
        paras: [
          'The Agent Activity map shows every agent session at its pipeline stage: session opened, grant recorded, proposal presented, order placed or verdict issued. Each bot icon is a real session record, with a verdict badge for its receipt. Icons move only when a stored record changes, and the map refreshes every 20 seconds.',
          "It lives in the merchant dashboard next to Agent orders. It is read-only and shows pipeline stage, not live browsing, and it is not the merchant's floorplan or a camera view. In the demo, the traffic is simulated agent traffic for Northwind Outfitters.",
        ],
        image: { src: '/features/agent-activity-map.jpg', alt: 'The Agent Activity map in the merchant dashboard, labelled as simulated agent traffic for Northwind Outfitters.' },
        cta: { label: 'See it in the dashboard', to: '/dashboard' },
      },
    ] as { id: string; icon: string; title: string; short: string; paras: string[]; image?: { src: string; alt: string }; cta?: { label: string; to: string } }[],
    ctaTitle: 'Want this on your store?',
    ctaLabel: 'Reach out for pilot',
  },

  faq: {
    id: 'faq',
    eyebrow: 'The details matter',
    headline: 'Questions, answered.',
    body: 'How the trust layer fits your operation — and what it does not do.',
    items: [
      {
        q: 'Can agents make errors?',
        a: [
          { t: "Yes. Agents can make errors from misinterpreting the user's need to overstepping to misunderstanding marketing summaries and formal terms." },
          { t: "Those errors become the merchant's chargebacks and returns — Agent Receipt catches them before fulfillment." },
        ],
      },
      {
        q: 'How does Agent Proceed fit into my existing order flow?',
        a: [
          { t: 'It sits between agent order and fulfillment, as a checkpoint — it checks the order, returns a signal, and your system holds shipment on that signal.' },
          { t: 'It does not replace your checkout, payment, or order system.' },
        ],
      },
      {
        q: 'How does it connect to my Shopify store?',
        a: [
          { t: 'Agent Proceed does not replace your Shopify checkout, payment, or fulfillment — it checks orders after they are placed, before fulfillment, and returns a Ship / Hold signal to your dashboard.' },
        ],
      },
      {
        q: 'Does this change my checkout or slow fulfillment?',
        a: [
          { t: 'No checkout change for the customer — the check happens at order received, before fulfillment, not at payment.' },
          { t: 'Fulfillment is only held on flagged orders you choose to review; Pass orders proceed as normal, with no extra step.' },
        ],
      },
      {
        q: 'Which agents does this work with?',
        a: [
          { t: 'We support all verified agents with shopping support capability.' },
          { t: 'We are continuously evolving our list of covered agents.' },
        ],
      },
      {
        q: 'What data do you access, and is my customer data safe?',
        a: [
          { t: "We access only that purchase's grant fields, action record, and hash-sealed receipt — no full customer chat, no other orders' data, and Merchant A never sees Merchant B's orders." },
          { t: "Your customer data is used only to check that order and to optimize that merchant's listings — it is not sold, shared with other merchants, or used to train other orders' checks." },
        ],
      },
      {
        q: 'What are the products / features offered?',
        a: [
          { t: 'Agent Receipt — catches mismatches before fulfillment.', to: '/products#order-check', toLabel: 'Details → Products page' },
          { t: 'Listing Optimizer + Read as Agent — listing fixes from mismatch data and agentic-retrieval gaps, merchant-approved only.', to: '/products#listing-optimizer', toLabel: 'Details → Products page' },
          { t: 'Evidence Packet — downloadable Evidence Packet for a disputed shipped order.', to: '/products#evidence-pack', toLabel: 'Details → Products page' },
          { t: 'Agent Activity tracker — see every agent in your store, at its pipeline stage, in the merchant dashboard.', to: '/products#agent-activity', toLabel: 'Details → Products page' },
        ],
      },
    ] as { q: string; a: FaqLine[] }[],
  },

  pilot: {
    id: 'pilot',
    eyebrow: 'Start a conversation',
    headline: 'Reach out for pilot',
    body: 'Pilot merchants get the trust layer on their store.',
    footLabel: 'Built for merchants adapting to agentic shopping',
    fields: {
      name: 'Name',
      email: 'Work email',
      company: 'Company / Store name',
      url: 'Store URL (optional)',
      urlPlaceholder: 'https://',
      interest: 'I want to',
      message: 'Message (optional)',
    },
    interestOptions: ['Join a pilot', 'Stay in the loop'],
    submit: 'Submit',
    sending: 'Sending…',
    success: 'Thanks. We have your request and will be in touch.',
    error: 'Sorry, that did not send. Please try again.',
    privacy: 'We use these details only to reply to your request.', // PLACEHOLDER: confirm wording
  },

  // The Hackathon page (/hackathon): a demo launchpad for judges.
  hackathon: {
    eyebrow: 'Hackathon demo',
    headline: 'Try Agent Proceed in two minutes.',
    tagline: 'Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent.',
    demos: [
      { title: 'Chat with the shopper agent', to: '/chat', note: 'Muse, a shopping agent, buys from the Northwind Outfitters demo store for you.' },
      { title: 'Demo store', to: '/shop', note: 'Northwind Outfitters: the store the agent shops in, as a shopper or an agent sees it.' },
      { title: 'Merchant dashboard', to: '/dashboard', note: 'The demo sign-in is pre-filled for Northwind Outfitters: one tap, no password.' },
    ],
    repoLabel: 'Source code on GitHub',
    repoUrl: 'https://github.com/snehatiwari029/AgentProceed',
    tryTitle: 'What to try',
    trySteps: [
      { title: 'Chat', text: 'Open the chat, tap "Try the demo test sequence" and send it. Muse finds a snowboard and places the order.' },
      { title: 'Store', text: 'Open the store and find the snowboard Muse picked. Compare its listing with what Muse told the customer.' },
      { title: 'Dashboard: agent activity map', text: 'Sign in to the dashboard and open Agent activity from the sidebar. The new session is a bot at the checkout line, with a verdict badge for its receipt.' },
      { title: 'Dashboard attention', text: 'Back on the dashboard home, "Orders requiring attention" now includes the new order, read live.' },
      { title: 'Mismatch', text: 'In Agent orders, open the new order and click Show check: the total including shipping is over the budget, and "easy returns" does not match Final Sale terms.' },
    ],
    note: 'Demo: simulated store and simulated payments. Each chat order is a real demo order in the dashboard.',
  },

  footer: {
    line: 'Agent Proceed: everything merchants need to sell confidently when the shopper is an AI agent.',
    links: [
      { label: 'LinkedIn', href: 'https://www.linkedin.com/in/snehatiwari02', external: true },
      { label: 'Dashboard', href: '/dashboard', external: false },
      { label: 'Store', href: '/shop', external: false },
    ],
    note: 'Demo: simulated store and simulated payments. The verified-agent signal shown in the demo is simulated.',
  },
}
