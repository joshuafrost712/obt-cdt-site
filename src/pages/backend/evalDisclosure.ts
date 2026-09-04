/**
 * What the participant is told about who sees what. Spec SITE-02 D5.
 *
 * ## Why this is a table and not a paragraph
 *
 * Program rubric row 2 says every sentence in this panel is true of the database,
 * and that a claim with no assertion is a defect rather than an omission. The
 * spec's own review found how that row fails in practice: with the panel written
 * as prose, "enumerate the sentences from the rendered page" means splitting text
 * on full stops, and a build session then writes the four assertions it already
 * knows it can pass.
 *
 * So the panel IS this array. The page renders one row per entry through `L`, and
 * `site02-ui.mjs` iterates the same array, asserts each node's text is on screen,
 * and asserts each named assertion exists and ran. Adding a sentence with no
 * assertion turns the criterion red, which is criterion 6's own mutation.
 *
 * ## The word is unattributed, not anonymous
 *
 * SITE-01's finding 6, and it is the reason sentence 5 exists. A written
 * suggestion describing your own situation identifies you whatever the schema
 * does, and on a session three people attended the item identifies you regardless
 * of what you wrote. A panel that said "anonymous" would be false in a way this
 * schema cannot fix.
 */

/**
 * The assertion names, which are a closed vocabulary shared with the harness.
 *
 * Nine of these are criterion 6's own list. The tenth,
 * `facilitator-cannot-read-base-tables`, is added here because sentence 3 claims
 * it in so many words and the other nine do not cover it: SITE-01's criterion 10
 * proves it about the schema, and this panel is where it is promised to a person.
 * It is mutation-tested exactly like the rest.
 */
export const EVAL_ASSERTIONS = [
  'facilitator-read-has-no-name',
  'comments-do-not-correlate',
  'facilitator-reads-refuse-while-open',
  'author-reads-own-after-close',
  'second-participant-reads-zero',
  'facilitator-cannot-read-base-tables',
  'head-mentor-read-is-attributed',
  'suppression-fires-below-min-n',
  'n-absent-in-facilitator-read',
  'imported-round-is-distinguishable',
] as const

export type EvalAssertion = (typeof EVAL_ASSERTIONS)[number]

export interface DisclosureRow {
  node: string
  fallback: string
  /** At least one, and every one of them runs in the build session. */
  assertions: EvalAssertion[]
  /**
   * `always` renders on every round. `imported` renders only when the earlier
   * round in this workshop was run on the Google Form, because a participant
   * reading the standard panel would otherwise be told something that is not
   * true of those answers.
   *
   * The page's condition is two readable facts, not a guess: the earlier
   * response this participant can read carries `source = 'manual'`, or they were
   * on the earlier round's list and nothing of theirs is readable at all — which
   * is program finding 28's state, true of the whole Bali round.
   */
  when: 'always' | 'imported'
}

export const DISCLOSURE: DisclosureRow[] = [
  {
    node: 'portal.eval.disclosure.aggregates',
    fallback:
      'Your facilitators see the ratings added up, and they see them only after the round has closed.',
    assertions: ['facilitator-reads-refuse-while-open'],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.unattributed',
    fallback:
      'They see what you write with no name on it, and no way to line your comments up with each other across sessions.',
    assertions: ['facilitator-read-has-no-name', 'comments-do-not-correlate'],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.yours',
    fallback:
      'Apart from the two people named below, nobody but you can read your own answers, and you can still read them here after the round closes.',
    assertions: [
      'second-participant-reads-zero',
      'author-reads-own-after-close',
      'facilitator-cannot-read-base-tables',
    ],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.oversight',
    fallback:
      'The head mentor and the site administrator can see who wrote what. That exists so that something serious written in a comment box reaches someone who can act on it.',
    assertions: ['head-mentor-read-is-attributed'],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.small-n',
    fallback:
      'Where only a few people rated something, the numbers are withheld rather than published. Even so, on a session only a few people attended, the item itself narrows who could have written a comment, and so does a comment that describes your own situation.',
    assertions: ['suppression-fires-below-min-n'],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.absence',
    fallback:
      '"I wasn\'t there" is a real answer and is counted as its own thing. Your facilitators can see how many people gave it, which is why it never becomes a low rating.',
    assertions: ['n-absent-in-facilitator-read'],
    when: 'always',
  },
  {
    node: 'portal.eval.disclosure.imported',
    fallback:
      'The earlier round was run on a Google Form. Those answers went to a spreadsheet in Joshua\'s Drive and he read them there, and he is one of the people being rated. Nothing on this page changes that.',
    assertions: ['imported-round-is-distinguishable'],
    when: 'imported',
  },
]
