// Mock WOCOO ticket used during Phase A (pre-Jira-OAuth). Real values from WOCOO-22597
// so the panel looks indistinguishable from a real ticket when reviewed.

export interface WocooTicket {
  id: string;
  summary: string;
  description: string;
  status: 'Triage' | 'Back Office' | 'Pending' | 'Done' | 'Cancelled' | 'Other';
  priority: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
  workType: string;
  category: string;
  identityId: string;
  accountId: string;
  clientEmail: string;
  tier: 'Core' | 'Premium' | 'Generation';
  totalReimbursementAmount: number | null;
  /** Count of files attached to the Jira ticket. Used by detection to distinguish
   *  fee-waiver tickets with supporting evidence (route to Reverse Fee) from those
   *  without (route to Verify Eligible DD manually). */
  attachmentCount: number;
  reporter: string;
  reporterAccountId?: string; // needed for @mention in Overpayment Triage comment step
  assignee: string;
  created: string;
  recentComments: Array<{ author: string; timestamp: string; body: string }>;
  zendeskTranscript: {
    state: 'success' | 'fetching' | 'partial' | 'error';
    zendeskTicketId?: string;
    text?: string;
  };
}

export const MOCK_TICKET: WocooTicket = {
  id: 'WOCOO-22597',
  summary: 'Declined Mastercard transaction: Code 51 — insufficient funds',
  description:
    "Hello team, This client is unable to use their Mastercard, both virtual and physical, with a certain merchant. " +
    "The Atlas error decline code is showing us error 51, which is insufficient funds; however, the client does have " +
    "enough funds to cover the transaction. Can we please look into the client's account, thank you. " +
    "Please see Zendesk Support tab for further comments and attachments.",
  status: 'Triage',
  priority: 'Medium',
  workType: 'Prepaid Card: Transactions',
  category: 'Prepaid Card: Declined Transactions',
  identityId: 'identity-gJLRchfi_P_5fOXq0b0cxBWcM0M',
  accountId: 'WK7LNXW30CAD',
  clientEmail: 'client@example.com',
  tier: 'Core',
  totalReimbursementAmount: null,
  attachmentCount: 0,
  reporter: 'Albert Manantan',
  assignee: 'Albert Cai',
  created: '2026-06-08T11:52:00Z',
  recentComments: [
    {
      author: 'Automation for Jira',
      timestamp: '2026-06-08T11:52:00Z',
      body: 'Atlas Identity Link: https://atlas.wealthsimple.com/identity/identity-gJLRchfi_P_5fOXq0b0cxBWcM0M/overview/?ticketId=WOCOO-22597',
    },
  ],
  zendeskTranscript: {
    state: 'success',
    zendeskTicketId: '13605113',
    text: [
      'AGENT: Hello, am I speaking to Michael?',
      'CLIENT: Yes, speaking.',
      "AGENT: Hello, Michael. My name is Morgan. I'm calling on behalf of Wealthsimple regarding the support ticket you opened about your Mastercard. Is now a good time?",
      'CLIENT: Yes, that works.',
      "AGENT: Thank you. I can see the card is being declined with a code 51 at one specific merchant. I've confirmed your available balance covers the amount, so this looks like a merchant-side issue rather than a funding issue on our end.",
      'CLIENT: OK, so what do I do?',
      "AGENT: I'm going to escalate this to our card operations team so they can investigate why the merchant is rejecting the transaction. You should hear back from us within 2–3 business days.",
      'CLIENT: Got it. Thank you.',
    ].join('\n'),
  },
};
