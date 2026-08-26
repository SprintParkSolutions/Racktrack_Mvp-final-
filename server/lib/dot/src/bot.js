/**
 * The hybrid router.
 *
 * Routes are chosen by measured search confidence, not by model judgment, so
 * routing is deterministic and testable. docs/ROUTING-CONTRACT.md is the
 * authoritative specification; this file implements it and the eval enforces it.
 *
 * In descending order of safety:
 *
 *   verbatim         search is confident and unambiguous. Return the verified
 *                    answer word for word. Zero hallucination risk, zero cost.
 *   grounded         relevant entries, no clear winner. The model phrases an
 *                    answer using ONLY those entries, and the output is
 *                    validated before the user sees it.
 *   suggestions      same situation, no model available. Offer the candidate
 *                    questions and let the user pick.
 *   needs-access     a good answer exists above the caller's clearance. Say so.
 *   out-of-scope     a question we must never answer from a model (pricing,
 *                    roadmap, other vendors' kit, product facts we lack).
 *   general          plainly not about RackTrack. Answered from world
 *                    knowledge, clearly labelled, never citing the product.
 *   refusal          nothing relevant. Say so and escalate. Never guess.
 *
 * The guarantee that matters: a fact about RackTrack only ever reaches a user
 * from a verified knowledge-base entry.
 */

import { fileURLToPath } from 'node:url'
import { loadKB, filterByTier } from './kb.js'
import { buildIndex, search, THRESHOLDS } from './search.js'
import {
  buildSystem,
  buildGeneralSystem,
  verbatimAnswer,
  refusal,
  escalationFor,
  parseSources,
  REFUSAL_SENTINEL,
  GENERAL_LABEL,
} from './prompt.js'
import * as llm from './llm.js'
import { selectPassage } from './passage.js'
import { buildSemanticIndex, semanticSearch, fuse } from './semantic.js'
import * as reranker from './rerank.js'

/**
 * Whether a model may answer questions that have nothing to do with RackTrack.
 *
 * OFF by default, and that default was chosen from watching it on. A support bot
 * that writes six paragraphs of workplace advice, translates Telugu and explains
 * how to keep a pet mouse away from a cat — then cannot say what a port is —
 * reads as broken, however good the individual answers are. It also produced the
 * one failure this whole design exists to prevent: asked "what devies rakctrack
 * will detect", the model invented a list of discovery protocols the product may
 * not support, because a misspelled product name slipped past the scope check.
 *
 * Greetings, thanks and arithmetic are still answered, deterministically and
 * without a model, because those cost nothing and make the bot usable.
 *
 * Set GENERAL_ANSWERS=on to allow the model to answer off-topic questions.
 */
const GENERAL_ANSWERS = process.env.GENERAL_ANSWERS === 'on'

/**
 * Cosine similarity at which a semantic match counts as evidence in its own
 * right. Set from the observed range: unrelated entries sit near 0.3-0.45,
 * genuine paraphrase matches land 0.6 and above.
 */
const SEMANTIC_TRUST = Number(process.env.SEMANTIC_TRUST || 0.58)

/** How long a failed semantic-index build is trusted before trying again. A
 *  permanently cached failure meant embeddings never recovered without a restart. */
const SEMANTIC_RETRY_MS = Number(process.env.SEMANTIC_RECHECK_MS || 60_000)

const indexes = new Map()
const semanticIndexes = new Map()

/**
 * Build the semantic index per tier. Returns null when no embedding model is
 * present, in which case retrieval stays keyword-only and everything still
 * works — semantic search is an upgrade, not a dependency.
 */
async function getSemanticIndex(tier) {
  const cached = semanticIndexes.get(tier)
  if (cached && (cached.index || Date.now() - cached.at < SEMANTIC_RETRY_MS)) return cached.index

  const allowed = filterByTier(loadKB().entries, tier)
  // fileURLToPath, not .pathname: on Windows a file URL's pathname is
  // "/C:/Users/..." which fs cannot open, so the cache would silently never load
  // or save and semantic search would re-embed the whole corpus every start.
  const cache = fileURLToPath(new URL(`../kb/embeddings-${tier}.json`, import.meta.url))
  let index = null
  try {
    index = await buildSemanticIndex(allowed, cache)
  } catch {
    index = null
  }
  semanticIndexes.set(tier, { index, at: Date.now() })
  return index
}

/**
 * Index over EVERY entry regardless of tier. Never used to answer — only to
 * detect that a good answer exists above the caller's clearance, so we can say
 * so instead of substituting an unrelated entry.
 */
let _fullIndex = null
function getFullIndex() {
  if (!_fullIndex) _fullIndex = buildIndex(loadKB().entries)
  return _fullIndex
}

/** Human-readable feature area, for access-denied messages. */
function featureAreaOf(entry) {
  if (entry.category) return `the ${entry.category} area`
  const nice = {
    admin: 'the administration area',
    integrations: 'connected systems',
    account: 'team and account settings',
  }
  return nice[entry.domain] || 'an administrator-only area'
}

/** Build (once) and return the tier-scoped search index. */
function getIndex(tier) {
  if (!indexes.has(tier)) {
    const kb = loadKB()
    const visible = filterByTier(kb.entries, tier)
    indexes.set(tier, { index: buildIndex(visible), count: visible.length })
  }
  return indexes.get(tier)
}

/** Warm indexes for every tier at startup so the first user request is fast. */
export function warmup() {
  const out = {}
  for (const tier of ['end-user', 'admin']) out[tier] = getIndex(tier).count
  return out
}

/**
 * Answer one question.
 *
 * @param {string} question
 * @param {object} opts
 * @param {'end-user'|'admin'} opts.tier
 * @param {Array<{role,content}>} opts.history - prior turns, for follow-ups
 * @returns {Promise<{answer, sources, route, confidence, matches, warnings}>}
 */
export async function ask(question, { tier = 'end-user', history = [] } = {}) {
  const q = String(question || '').trim()
  const turns = sanitizeHistory(history)

  if (!q) {
    return reply({ answer: 'What can I help you with?', route: 'empty' })
  }

  // Safety guard, before anything else. Users in a hurry paste credentials into
  // support chats constantly. Never let that pass silently - the message is
  // already logged by the time we see it, so the honest response is to tell
  // them to rotate it.
  const credential = detectCredential(q)
  if (credential) {
    return reply({
      answer:
        `Before anything else: it looks like you included ${credential} in that message. ` +
        `Please change it now, and don't share it in a support chat - I don't need it and it may be stored in this conversation.\n\n` +
        `Once you've changed it, describe the problem again without it and I'll help.`,
      route: 'credential-guard',
      warnings: ['user shared a credential'],
      // Tells the caller this text must not be logged or stored anywhere.
      sensitive: true,
    })
  }

  // Some questions must never be answered by a model, however well the words
  // happen to match: roadmap and pricing are not facts that live in a support
  // knowledge base, a comparison needs knowledge of someone else's product, and
  // configuration steps for another vendor's hardware can take a datacenter
  // down. These are caught by intent, before scoring runs (contract §4).
  const blocked = classifyScope(q)
  if (blocked) {
    // Each kind carries its own onward route. The generic "capture the error
    // and escalate" line belongs to a failure, and reads as a non sequitur
    // after a question about pricing.
    return reply({
      answer: `${blocked.reply} ${blocked.escalation}`,
      route: 'out-of-scope',
      warnings: [`out of scope: ${blocked.kind}`],
    })
  }

  // The suggestion menu ends with "Reply with the number and I'll walk you
  // through it", so a bare number has to mean that. Reading the choice back out
  // of the menu we just printed keeps this stateless — no session storage, and
  // it still works if the client replays an older conversation.
  const chosen = resolveMenuChoice(q, turns)
  if (chosen) return ask(chosen, { tier, history: [] })

  // Greetings, arithmetic and "what time is it" are unambiguous and cannot be
  // product questions, so they are answered before retrieval rather than after
  // it — searching a rack knowledge base for "17 * 24" only ever produces
  // noise that then has to be filtered back out.
  if (!isProductScoped(q)) {
    const quick = trySimpleAnswer(q)
    if (quick) return reply({ answer: quick, route: 'general-fallback' })
  }

  const { index } = getIndex(tier)

  // Follow-ups ("why?", "it still doesn't work") carry no searchable terms of
  // their own. Blend in the previous user turn so search has something to work with.
  const lastUser = [...turns].reverse().find((m) => m.role === 'user')
  const searchQuery = lastUser && looksLikeFollowUp(q) ? `${lastUser.content} ${q}` : q

  const keyword = search(index, searchQuery, { limit: 8 })

  // Semantic search runs alongside, and the two rankings are fused. Keyword
  // search finds exact strings (error text, button labels); semantic search
  // finds meaning ("signed out" ~ "session expired"). Neither alone is enough.
  const semIndex = await getSemanticIndex(tier)
  const semantic = semIndex ? await semanticSearch(semIndex, searchQuery, 8) : []

  let matches = semantic.length ? fuse(keyword, semantic, 4) : keyword.slice(0, 4)
  const warnings = []

  // Before answering weakly — or refusing — check whether a GOOD answer exists
  // that this caller simply is not cleared to see. Telling a technician "that
  // is an admin screen" is a real answer; handing them an unrelated entry
  // because it scored best within their tier is not.
  const restricted = restrictedAnswer(tier, searchQuery, matches)
  if (restricted) {
    return reply({
      answer:
        `That's part of ${featureAreaOf(restricted.entry)}, which needs administrator access — so I can't walk you through it here.\n\n` +
        `Your RackTrack administrator can help, or can give you access if you need it.`,
      route: 'needs-access',
      warnings: [`restricted answer exists (${restricted.entry.id}, conf ${restricted.confidence})`],
    })
  }

  // A near-tie between candidates is exactly what lexical scoring cannot
  // resolve and a model can: it reads each candidate against the question and
  // scores relevance. It only reorders verified entries, so the worst a bad
  // rerank can do is pick a different verified answer.
  if (matches.length > 1 && !passesVerbatimGates(matches[0], q)) {
    try {
      if ((await reranker.isAvailable()).ok) {
        matches = await reranker.rerank(q, matches)
        warnings.push('reranked by relevance')
      }
    } catch (err) {
      warnings.push(`rerank unavailable: ${err.message}`)
    }
  }

  // --- Route 1: a confident, unambiguous match. Quote it. -----------------
  // Every gate in contract §2 must pass. The knowledge base is the source of
  // truth, so when this fires no model is involved: it is faster, costs
  // nothing, and cannot hallucinate.
  const answerable = matches.find((m) => passesVerbatimGates(m, q))
  if (answerable) {
    const passage = selectPassage(answerable.entry, q, index.idf, index.maxIdf)
    const base = verbatimAnswer(answerable.entry)
    return reply({
      answer: passage ? passage.text : base.answer,
      detail: passage ? answerable.entry.answer : base.detail,
      sources: [answerable.entry.id],
      route: 'verbatim',
      confidence: answerable.confidence,
      matches: summarize(matches),
      warnings: passage ? [...warnings, `led with passage ${passage.index} (match ${passage.score})`] : warnings,
    })
  }

  // --- Route 2: relevant entries, no clear winner. ------------------------
  // Something in the knowledge base is genuinely about this question, but not
  // clearly enough to quote one entry. Let the model choose and phrase — or,
  // with no model, show the candidates and let the user choose.
  // A question asking for a precise figure has no useful ambiguous answer: a
  // menu of related entries is not "the timeout is X", and the model phrasing
  // one from an entry that never states the number is exactly how a support bot
  // invents a value a customer then plans around.
  if (demandsExactValue(q)) {
    return reply({
      answer:
        `I don't have the exact figure you're asking for — I'd rather say so than quote a number that turns out to be wrong. ` +
        escalationFor(tier),
      route: 'out-of-scope',
      confidence: matches[0]?.confidence ?? 0,
      warnings: [...warnings, 'out of scope: product-fact-we-lack (no verified figure)'],
    })
  }

  const candidates = matches.filter(isEvidence)
  if (candidates.length > 0) {
    const model = await llm.isAvailable()
    if (model?.ok) {
      const grounded = await answerGrounded(q, candidates, tier, turns)
      if (grounded.ok) {
        return reply({
          answer: grounded.answer,
          sources: grounded.sources,
          route: 'grounded',
          confidence: matches[0].confidence,
          matches: summarize(matches),
          warnings: [...warnings, `grounded via ${grounded.backend}`],
        })
      }
      warnings.push(`grounded answer rejected: ${grounded.reason}`)
    }

    return reply({
      answer: buildSuggestionAnswer(candidates, tier),
      options: suggestionOptions(candidates),
      sources: [],
      route: 'suggestions',
      confidence: matches[0].confidence,
      matches: summarize(matches),
      warnings,
    })
  }

  // A question about how to switch on a named feature, where nothing in the
  // corpus is about it, is asking about something we do not have. Saying "I
  // don't have reliable information" invites the user to rephrase a question
  // about a feature that does not exist, so say that instead.
  if (asksToUseAFeature(q)) {
    return reply({
      answer:
        `I can't find anything like that in RackTrack. It may not exist, or it may be called something else here - ` +
        `if you tell me what you're trying to achieve, or the exact wording on your screen, I'll take another look.`,
      route: 'out-of-scope',
      confidence: matches[0]?.confidence ?? 0,
      matches: [],
      warnings: [...warnings, 'out of scope: product-fact-we-lack (no entry covers the named feature)'],
    })
  }

  // Not enough to hand a model, but the question does name something real in the
  // product — "scan is not working" is every technician's opening line. A menu
  // is the useful reply there; refusing reads as "I have nothing on scanning",
  // which is untrue. A vague question naming nothing in the product ("i cant
  // walk") gets no menu, because every option would be a guess.
  const offerable = matches.filter(isWorthOffering)
  if (offerable.length > 0 && isProductScoped(q)) {
    return reply({
      answer: buildSuggestionAnswer(offerable, tier),
      options: suggestionOptions(offerable),
      sources: [],
      route: 'suggestions',
      confidence: matches[0].confidence,
      matches: summarize(matches),
      warnings: [...warnings, 'weak match — offered candidates rather than answering'],
    })
  }

  // --- Route 3: nothing in the knowledge base is about this. --------------
  // If the question touches the product at all, the only honest answers are a
  // verified entry or an admission that we do not have one. A model's
  // impression of what a rack-auditing app "probably" does is not an answer.
  // Scope is judged on the blended query, so a three-word follow-up inherits the
  // subject of the turn before it. "what are its cons?" on its own looks like a
  // general question; after a question about RackTrack it plainly is not, and
  // answering it from world knowledge would be inventing product criticism.
  if (isProductScoped(searchQuery)) {
    return reply({
      ...refusal(tier),
      route: 'refusal',
      confidence: matches[0]?.confidence ?? 0,
      warnings,
    })
  }

  // Plainly not about RackTrack: a definition, some arithmetic, small talk.
  // Answer it, and label it so nobody mistakes it for product documentation.
  const simple = trySimpleAnswer(q)
  if (simple) {
    return reply({ answer: simple, route: 'general-fallback', warnings })
  }

  if (GENERAL_ANSWERS) {
    const model = await llm.isAvailable()
    if (model?.ok) {
      try {
        const result = await llm.generate(buildGeneralSystem(tier), [...turns, { role: 'user', content: q }])
        const text = parseSources(result?.text || '').answer
        if (text) {
          return reply({
            answer: `${GENERAL_LABEL}\n\n${text}`,
            route: 'general',
            warnings: [...warnings, `general answer via ${result.backend || 'llm'}`],
          })
        }
      } catch (err) {
        warnings.push(`general-answer model failed: ${err.message}`)
      }
    }
  }

  // Off-topic, and general answering is off. Say what this bot is for rather
  // than "I don't have reliable information about that" — the question was not
  // unclear, it was addressed to the wrong assistant, and telling the user what
  // to ask instead is the useful reply.
  return reply({
    answer:
      `I'm the RackTrack support assistant, so I can only help with RackTrack itself - scans, racks, switches, ports, reports, and your account.\n\n` +
      `If that was meant to be a RackTrack question, tell me what you were doing or what's on your screen and I'll look again.`,
    route: 'out-of-scope',
    warnings: [...warnings, 'out of scope: not about RackTrack'],
  })
}

/** Normalize every return so callers always see the same shape. */
function reply({ answer, detail = null, sources = [], route, confidence = 0, matches = [], warnings = [], sensitive = false, options = [] }) {
  return { answer, detail, sources, route, confidence, matches, warnings, sensitive, options }
}

// ── Answering ────────────────────────────────────────────────────────

/**
 * Ask the model to phrase an answer from the candidate entries, then check its
 * work before anyone sees it. Generated text is never trusted (contract §3):
 * a failed check falls back to the suggestion menu, never to the raw output.
 */
async function answerGrounded(question, candidates, tier, turns) {
  try {
    const system = buildSystem(candidates, tier)
    const result = await llm.generate(system, [...turns, { role: 'user', content: question }])
    const parsed = parseSources(result?.text || '')

    if (isModelRefusal(parsed.answer)) return { ok: false, reason: 'model reported insufficient context' }

    const check = validate(parsed, candidates)
    if (!check.ok) return { ok: false, reason: check.reason }

    return { ok: true, answer: parsed.answer, sources: parsed.sources, backend: result.backend || 'llm' }
  } catch (err) {
    return { ok: false, reason: `model call failed: ${err.message}` }
  }
}

function isModelRefusal(answer) {
  return (
    answer.includes(REFUSAL_SENTINEL) ||
    /don't have reliable information/i.test(answer) ||
    /insufficient.context/i.test(answer) ||
    /I could ?n[o']t find/i.test(answer) ||
    /not covered in the (provided |given )?(?:facts|context|information)/i.test(answer)
  )
}

/**
 * Guardrail on model output. Cheap checks that catch the common small-model
 * failure modes before the user ever sees the text.
 */
export function validate(parsed, matches) {
  const validIds = new Set(matches.map((m) => m.entry.id))

  if (!parsed.answer || parsed.answer.trim().length < 2) {
    return { ok: false, reason: 'empty answer' }
  }

  // A cited id that was not in the entries we supplied means the model invented
  // a source, which is a strong signal it invented the content too.
  for (const id of parsed.sources) {
    if (!validIds.has(id)) return { ok: false, reason: `cited unknown source "${id}"` }
  }

  // A substantive answer with no sources at all is ungrounded by definition.
  if (parsed.sources.length === 0) {
    return { ok: false, reason: 'substantive answer with no sources cited' }
  }

  // Small models sometimes leak the scaffolding.
  if (/--- (END )?FACTS ---|^RULES:|system prompt/im.test(parsed.answer)) {
    return { ok: false, reason: 'leaked prompt scaffolding' }
  }

  return { ok: true }
}

/**
 * Every gate that must pass before an entry is quoted verbatim (contract §2).
 * Each one exists because of a specific way the others can be satisfied by an
 * answer that is nonetheless wrong.
 */
export function passesVerbatimGates(match, question) {
  if (!match) return false
  // An entry only the embedding model found has no keyword evidence behind it,
  // so it can be a candidate to phrase from but never a quotation.
  if (match.semanticOnly) return false
  if (match.confidence < THRESHOLDS.DIRECT) return false
  if ((match.matchedTerms ?? 0) < THRESHOLDS.MIN_TERMS_FOR_DIRECT) return false
  // Two gates are waived for an entry that asks the user's question more
  // completely than anything else does. That is not a near-tie and it is not a
  // thin match — it is the answer.
  //
  // The waiver matters most for the questions a corpus is worst at. "What are
  // ports?" is the plainest question a technician can ask, and every word in it
  // appears in hundreds of entries, so it carries almost no statistical weight
  // and both the margin and information floors reject it. The entry that
  // literally asks "What are ports?" should answer it anyway.
  // Either kind of lead qualifies: the entry contains more of the question than
  // anything else does, or — when several entries contain all of it — the entry
  // asks the least beyond it.
  // The waiver also needs the entry to ask little BEYOND the question. Overlap
  // alone is trivially satisfied by a two-word query against a long question:
  // "scan is not working" fully overlapped an entry headed "My scan images are
  // broken / blank but the app otherwise works", which then answered a vague
  // question with a very specific cause.
  const asksExactly =
    (match.questionOverlap ?? 0) >= 0.95 &&
    (match.questionPrecision ?? 0) >= 0.35 &&
    ((match.questionLead ?? 0) > 0 || (match.precisionLead ?? 0) > 0)
  // The three absolute-strength floors are what an exact question match waives.
  // They all measure the same thing from different angles — how much raw signal
  // the wording carried — and a question made of the product's commonest words
  // cannot carry much however precisely it is asked. Confidence, coverage and
  // the two-term minimum still apply, so a single vague word never gets here.
  if (!asksExactly) {
    if ((match.margin ?? 0) < THRESHOLDS.MIN_MARGIN_FOR_DIRECT) return false
    if ((match.matchedMass ?? 0) < THRESHOLDS.MIN_MATCHED_MASS) return false
    if ((match.score ?? 0) < THRESHOLDS.MIN_SCORE) return false
  }
  if ((match.coverage ?? 0) < THRESHOLDS.MIN_COVERAGE) return false
  if ((match.unknownRatio ?? 0) > THRESHOLDS.MAX_UNKNOWN) return false
  if (demandsExactValue(question) && !hasNumber(match.entry)) return false
  return true
}

/**
 * Is this match real evidence that the knowledge base covers the question?
 *
 * Ranking always returns something, so "best available" is not the same as
 * "relevant". A question about French geography still produces a top hit here;
 * what separates it from a real support question is that most of its vocabulary
 * is absent from the corpus and little of its information was matched. Without
 * these floors, unrelated questions landed in the ambiguous band and were
 * offered a menu of rack-topology entries instead of a straight answer.
 */
function isEvidence(match) {
  if (!match) return false
  if (match.semanticOnly) {
    // Different evidence, not absent evidence: an embedding match this strong
    // is a genuine paraphrase, which is the entire point of running it.
    return (match.similarity ?? 0) >= SEMANTIC_TRUST
  }
  return (
    match.confidence >= THRESHOLDS.GROUNDED &&
    (match.coverage ?? 0) >= THRESHOLDS.MIN_COVERAGE &&
    (match.score ?? 0) >= THRESHOLDS.MIN_SCORE &&
    (match.unknownRatio ?? 0) <= THRESHOLDS.MAX_UNKNOWN
  )
}

/**
 * Weak, but plausibly about the same thing — good enough to offer as a choice,
 * never good enough to state as an answer.
 */
function isWorthOffering(match) {
  if (!match) return false
  if (match.semanticOnly) return (match.similarity ?? 0) >= SEMANTIC_TRUST - 0.1
  return (
    match.confidence >= 0.3 &&
    (match.matchedTerms ?? 0) >= 1 &&
    (match.unknownRatio ?? 0) <= THRESHOLDS.MAX_UNKNOWN
  )
}

/**
 * Is the user asking how to switch on or find a specific named feature?
 *
 * Combined with "retrieval found nothing about it", this is what separates a
 * question about a feature we have not documented from one about a feature that
 * does not exist — and the honest reply differs between them.
 */
function asksToUseAFeature(text) {
  return /\b(?:how (?:do|can) i|how to|where (?:do|can) i|where is)\b.*\b(?:turn on|turn off|switch on|enable|disable|use|find|open|access|configure)\b/i.test(text) ||
    /\b(?:turn on|enable|where is)\b.*\b(?:the|my)\b.*\b(?:button|overlay|feature|mode|toggle|setting|panel|heatmap|report|tab)\b/i.test(text)
}

/**
 * Is there a good answer this caller is not cleared to see?
 *
 * Both sides are scored the same way — keyword confidence against keyword
 * confidence — because comparing a fused number with a keyword number is
 * comparing two different scales and produced access-denied replies for
 * questions the caller's own tier could have answered.
 *
 * Internal-only content is never alluded to. Naming an administrator feature is
 * helpful; hinting that an internal answer exists is a disclosure (contract §5).
 */
function restrictedAnswer(tier, searchQuery, matches) {
  if (tier === 'admin') return null

  // This route is for questions that ONLY have a restricted answer. If the
  // caller's own tier holds anything plausible, showing it — or offering a
  // choice — beats asserting that their account is the problem. "scan button
  // greyed out" was told it needed an administrator, off the back of an entry
  // about the Clear log button, while the caller's own tier had a candidate
  // about a disabled shutter.
  const inTier = matches.find((m) => !m.semanticOnly)?.confidence ?? 0
  if (inTier >= THRESHOLDS.DIRECT) return null

  // Four results, not one: with a single result there is no runner-up, so
  // `margin` is 1.0 by definition and every near-tie looked like a clear winner.
  const full = search(getFullIndex(), searchQuery, { limit: 4 })[0]
  if (!full || full.entry.audience !== 'admin') return null
  if (!passesVerbatimGates(full, searchQuery)) return null
  if (full.confidence - inTier < 0.15) return null

  // The restricted entry has to be about EXACTLY what was asked. Telling someone
  // their account lacks permission is an assertion about them, and it is worth
  // less than nothing when it is wrong. "scan button greyed out" earned that
  // reply from an entry about the Clear log button being greyed out: overlap
  // 0.88, because everything except the subject of the question matched. The
  // cases where the verdict is right sit at 1.00.
  if ((full.questionOverlap ?? 0) < 0.95) return null

  return full
}

// ── Question classification ──────────────────────────────────────────

/**
 * Categories of question that must never be answered from a model.
 *
 * These are not "we happen to be missing an entry" gaps that could be filled
 * later - they are questions whose answers do not live in a support knowledge
 * base at all. A confident wrong answer here becomes a promise to a customer,
 * a price nobody quoted, or a change to somebody else's switch.
 */
export function classifyScope(text) {
  const t = String(text || '').toLowerCase()

  const rules = [
    {
      kind: 'roadmap',
      // Future tense about capability. Code says what is, never what will be.
      // Grammar varies more than intent does: "when will you add", "when is the
      // next release shipping" and "when will the new dashboard be available"
      // are one question. Anchoring on a pronoun after "when is" missed most of
      // them.
      // Future intent, not merely the word "when". "When does the scan time out"
      // and "when does the occlusion model run" are present-tense questions about
      // behaviour we document, and a bare `when (does|is)` swallowed them.
      re: /\b(?:when will\b|when (?:is|are) (?:the )?(?:next|new|upcoming)\b|when (?:is|are)\b[^?]{0,40}\b(?:ship|shipping|shipped|released?|available|launch(?:ing)?|coming|ready)\b|will (?:you|it|there|this) (?:be|ever|add|support)|do you plan|any plans|planning to|on the roadmap|roadmap|next (?:release|version)|upcoming (?:release|feature|version)|future (?:release|version|plan)|coming soon|eta\b)/,
      reply:
        "I can only tell you how RackTrack works today - I don't have anything about future plans or release timing.",
      escalation: 'Your RackTrack administrator can raise a feature request with the product team.',
    },
    {
      kind: 'commercial',
      re: /\b(?:how much (?:does|is|would|will).{0,24}(?:cost|charge)|what.{0,12}(?:the )?(?:price|pricing|cost)\b|price per|cost per|per (?:user|seat|device|month|year) (?:cost|price|fee)|licen[cs]e (?:fee|cost|price)|subscription (?:cost|price|fee)|discount|quote\b|invoice|refund|billing)/,
      reply: "I only cover how to use RackTrack, so I don't have anything on pricing or billing.",
      escalation: 'Your RackTrack administrator or account manager can help with that.',
    },
    {
      kind: 'comparison',
      // "compared to last week" is a real support question about scan history,
      // so a bare comparison word is not enough — it has to be a comparison
      // against something other than the product's own past.
      // A comparison against another PRODUCT, not against anything at all. Two of
      // our own model variants get compared in the documentation (`"seg" vs
      // "dual"`) and a bare comparison word swallowed those; "RackTrack vs
      // NetBox" is the case the rule exists for.
      //
      // Capitalisation is the main signal, so that half is matched against the
      // original text — testing it after lowercasing looked for a capital letter
      // that had already been removed, which is how it stopped firing on NetBox.
      reRaw: /\b(?:better than|worse than|compared? (?:to|with)|versus|vs\.?)\s+(?!last\b|the last\b|previous\b|my previous\b|yesterday\b|earlier\b|before\b)[A-Z][A-Za-z0-9]{2,}/,
      re: /\b(?:competitor|alternative to|(?:better than|worse than|compared? (?:to|with)|versus|vs\.?)\s+(?:\w*\d\w*|netbox|device42|nautobot|racktables|opendcim|sunbird|nlyte|(?:another|other|any other|alternative|competing|rival)\s+(?:product|products|tool|tools|app|apps|vendor|system|systems)))/,
      reply:
        "I can explain what RackTrack does, but I can't compare it to other products - I don't have reliable information about them.",
      escalation: 'Happy to answer anything about using RackTrack itself.',
    },
    {
      kind: 'meta',
      // Attempts to extract or override the bot's own configuration. A model
      // asked politely enough will often comply, and the one asking is not a
      // technician with a rack problem — so this never reaches a model at all.
      re: /\b(?:system prompt|your (?:instructions|prompt|rules|training data|configuration)|ignore (?:all )?(?:previous|prior|above) instructions|disregard (?:your|all|previous)|reveal your|print your (?:prompt|instructions)|repeat your instructions|jailbreak|developer mode|pretend (?:you are|to be))\b/,
      reply:
        "I can't share how I'm set up, and I won't take on a different persona - the point of me is that my answers come from verified RackTrack help content.",
      escalation: 'Ask me anything about using RackTrack and I\'ll help.',
    },
    {
      kind: 'third-party-config',
      // Configuration advice for someone else's equipment. Plausible-sounding
      // wrong steps here are expensive in a live datacenter.
      re: /\b(?:cisco|juniper|arista|aruba|fortinet|mikrotik|ubiquiti|netgear|brocade|bgp|ospf|spanning[- ]tree|iptables|nginx|apache|kubernetes|active directory)\b/,
      needs: /\b(?:configure|configuration|config|set ?up|enable|disable|commands?|cli|troubleshoot|upgrade|flash|reset|fix)\b/,
      reply:
        "That's about configuring equipment outside RackTrack, and I'd only be guessing - the wrong step there is expensive.",
      escalation: "Check that vendor's own documentation, and I'll gladly help with the RackTrack side of it.",
    },
  ]

  for (const rule of rules) {
    const hit = (rule.re && rule.re.test(t)) || (rule.reRaw && rule.reRaw.test(text))
    if (!hit) continue
    if (rule.needs && !rule.needs.test(t)) continue
    return rule
  }
  return null
}

/**
 * Vocabulary that means the question is about our product.
 *
 * Deliberately broad. A false positive costs a general answer we could have
 * given; a false negative lets a model invent a RackTrack fact, which is the
 * failure this whole design exists to prevent.
 */
const PRODUCT_TERMS = /\b(?:racktrack|rack|racks|scan|scans|scanning|switch|switches|port|ports|firmware|cmdb|sfp|topology|marketplace|organi[sz]ation|tenant|technician|cabinet|cable|cabling|device|devices|inventory|discovery|audit|datacenter|data ?centre|sign ?in|sign ?out|log ?in|log ?out|password|account|profile|dashboard|report|export|sync|offline|app|screen|button|setting|settings|feature|integration|connection|history|camera|photo|photos|picture|image|flash|torch|shutter|blurry|upload|download|install|version|update|team|teammate|member|invite|email|username|session|internet|wifi|network|panel|patch|excel|csv|pdf|specs?|specification|firmware|eol|vendor|model)\b/i

/** Question shapes that are almost always about the product in a support chat. */
const SUPPORT_SHAPED = /^(?:how (?:do|can|would|should) (?:i|we|you)|how to|where (?:is|are|do|can)|why (?:is|are|does|did|do|cant|can't|cannot|wont|won't)|can (?:i|we|you)|is there a way|what happens when|turn on|turn off|enable|disable)\b/i

/**
 * Core vocabulary matched loosely, because people type in a hurry.
 *
 * "what devies rakctrack will detect" contains two typos and therefore matched
 * none of the exact product terms, so it was treated as a general question and a
 * model answered it by inventing a list of discovery protocols. A misspelling
 * must not be the thing that decides whether the product's own guarantee applies.
 */
const FUZZY_TERMS = ['racktrack', 'devices', 'switches', 'topology', 'firmware', 'marketplace', 'organization', 'inventory', 'scanning', 'password', 'account', 'install', 'network', 'connection', 'teammate', 'firmware']

export function isProductScoped(text) {
  const t = String(text || '').trim()
  if (PRODUCT_TERMS.test(t) || SUPPORT_SHAPED.test(t)) return true

  for (const word of t.toLowerCase().split(/[^a-z]+/)) {
    if (word.length < 5) continue
    for (const term of FUZZY_TERMS) {
      if (Math.abs(word.length - term.length) > 2) continue
      if (withinEditDistance(word, term, 2)) return true
    }
  }
  return false
}

/** Levenshtein distance, abandoned as soon as it exceeds `max`. */
function withinEditDistance(a, b, max) {
  if (a === b) return true
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (row[j] < best) best = row[j]
    }
    if (best > max) return false
    prev = row
  }
  return prev[b.length] <= max
}

/** Asks for a precise figure ("exactly how many milliseconds..."). */
function demandsExactValue(text) {
  const t = String(text || '').toLowerCase()
  return (
    /\b(?:exactly|precisely|exact)\b.*\b(?:how (?:many|much|long)|what|value|number|figure|setting)\b/.test(t) ||
    /\bhow many (?:milliseconds|ms|seconds|minutes|hours|bytes|kb|mb|items|entries|retries|attempts)\b/.test(t)
  )
}

/** Does this entry state any figure at all? */
function hasNumber(entry) {
  return /\d/.test(`${entry?.answer || ''} ${entry?.short || ''}`)
}

// ── Credentials ──────────────────────────────────────────────────────

/**
 * Detect a credential the user has volunteered. Returns a human label for what
 * was spotted, or null.
 *
 * Deliberately tuned to catch the obvious cases without firing on ordinary
 * questions like "I forgot my password". The signal is a credential being
 * *stated*, not *mentioned*.
 */
export function detectCredential(text) {
  // Shapes distinctive enough to be conclusive on their own.
  const unambiguous = [
    // Real keys carry internal separators (sk-proj-…, sk_live_…), so the run
    // after the prefix has to allow them or the common shapes slip through.
    { re: /\b(?:sk|pk|ghp|gho|xox[bpsa])[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}/, label: 'an API token' },
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'a session token' },
  ]
  for (const { re, label } of unambiguous) {
    if (re.test(text)) return label
  }

  // Labelled forms: "my password is X". The label alone is not enough - users
  // constantly say "my password is wrong", which mentions a credential without
  // stating one. Only fire when the value itself looks like a secret.
  const labelled = [
    { re: /\b(?:my\s+)?(?:password|passwd|pwd|passphrase)\s*(?:is|:|=)\s*(\S+)/i, label: 'your password' },
    { re: /\b(?:api[\s_-]?key|secret|token|bearer)\s*(?:is|:|=)\s*(\S+)/i, label: 'an API key or token' },
    { re: /\bcommunity\s*(?:string)?\s*(?:is|:|=)\s*(\S+)/i, label: 'an SNMP community string' },
  ]
  for (const { re, label } of labelled) {
    const m = text.match(re)
    if (m && statesAValue(m[1])) return label
  }

  return null
}

/**
 * Words that follow "my password is ..." when somebody is describing a problem
 * rather than handing over a secret. "My password is wrong" mentions a
 * credential; "my password is djwsqa" states one.
 */
const COMPLAINT_VALUES = new Set([
  'wrong', 'incorrect', 'invalid', 'expired', 'expiring', 'old', 'new', 'blank', 'empty',
  'gone', 'lost', 'forgotten', 'forgot', 'reset', 'changed', 'saved', 'correct', 'right',
  'fine', 'ok', 'okay', 'working', 'failing', 'failed', 'rejected', 'refused', 'refusing',
  'locked', 'disabled', 'required', 'missing', 'unknown', 'temporary', 'temp', 'case',
  'same', 'different', 'weak', 'strong', 'not', 'no', 'none', 'null', 'the', 'my', 'a', 'an', 'it',
])

/**
 * Did the user actually state a value after the label?
 *
 * This deliberately errs toward firing. Warning somebody who only described a
 * problem is a small annoyance; staying quiet while a real password is written
 * to a log and forwarded to a third-party model is an incident. So anything
 * that is not a recognisable complaint word or a pasted error code counts.
 *
 * An earlier version asked whether the value "looked random enough" — mixed
 * case, digits, symbols. A password of plain lowercase letters passed straight
 * through it, which is exactly the case a user is most likely to type out.
 */
function statesAValue(value) {
  const v = String(value).replace(/[.,!?;:'"]+$/, '')
  if (v.length < 4) return false
  // SCREAMING_SNAKE_CASE from a log is an error code, not a secret, and
  // refusing those would block the exact questions this bot exists to answer.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return false
  return !COMPLAINT_VALUES.has(v.toLowerCase())
}

/**
 * Keep conversation history to a shape we are willing to send to a model.
 *
 * The client supplies this array, so it is untrusted input: only user and
 * assistant turns survive, which is what stops a caller from smuggling in a
 * system message, and any turn that contains a credential is dropped rather
 * than forwarded to a third-party API on some later turn.
 */
function sanitizeHistory(history, max = 6) {
  if (!Array.isArray(history)) return []
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .filter((m) => m.role !== 'user' || !detectCredential(m.content))
    .slice(-max)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
}

// ── Fallbacks ────────────────────────────────────────────────────────

/**
 * Is this message a continuation of the previous one, rather than a new subject?
 *
 * Only a continuation may borrow the previous turn's words for searching. The
 * earlier rule — any question of four words or fewer — was far too broad, and it
 * caused two opposite failures in one conversation: "how ports are detected" (a
 * real question, four words) was searched together with the unrelated message
 * before it and refused, while "i have stomach ulcer" inherited enough product
 * vocabulary to be treated as a RackTrack question and given a support
 * escalation. A continuation is recognised by form: it is either almost empty on
 * its own, or it points back at something with a pronoun.
 */
function looksLikeFollowUp(text) {
  const t = String(text || '').trim().toLowerCase()
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.length <= 2) return true
  if (words.length > 6) return false
  if (/^(?:why|why not|how come|and|but|so|then|what about|ok|okay|still|really|nope|yes|no)\b/.test(t)) return true
  // A back-reference. "my" and "i" are excluded: they point at the speaker, not
  // at the previous turn, and "i have stomach ulcer" is not a follow-up.
  return /\b(?:it|its|it's|that|this|they|them|those|these|the same)\b/.test(t)
}

/**
 * Turn "2" into the question that was listed as item 2.
 *
 * Returns the chosen question text, or null when the message is not a menu
 * choice — including when it is a number that means something else, like "3" in
 * reply to "how many ports?", which is why the previous turn has to actually be
 * a menu for this to fire.
 */
function resolveMenuChoice(question, turns) {
  const m = question.match(/^\s*(?:option\s*)?([1-9])\s*[.)]?\s*$/i)
  if (!m) return null

  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
  if (!lastAssistant || !MENU_PROMPT.test(lastAssistant.content)) return null

  for (const line of lastAssistant.content.split('\n')) {
    const item = line.match(/^\s*([1-9])\.\s+(.*\S)\s*$/)
    if (item && item[1] === m[1]) return item[2]
  }
  return null
}

/** Recognises our own menu in the conversation history. */
const MENU_PROMPT = /Reply with the number/i

/** Menu shown when several entries are plausible and no model can choose. */
function suggestionOptions(matches) {
  return matches.map((m, i) => ({ n: i + 1, id: m.entry.id, question: m.entry.question }))
}

function buildSuggestionAnswer(matches, tier) {
  const lines = [
    tier === 'admin'
      ? 'I found a few things that might be relevant - which one sounds closest?'
      : "I'm not certain which issue you're hitting. Does one of these match?",
    '',
    ...matches.map((m, i) => `${i + 1}. ${m.entry.question}`),
    '',
    "Reply with the number and I'll walk you through it.",
  ]
  return lines.join('\n')
}

/**
 * Answers to conversational and arithmetic questions that need no model at all.
 * Only reached for questions already established as not being about RackTrack.
 */
function trySimpleAnswer(text) {
  const t = text.toLowerCase().trim()

  // Testers reported the bot ignoring "hi" and "hlo". "hi" was in fact handled;
  // "hlo" was not, and neither were "hii", "helo" or "hai" - all common ways
  // people actually type a greeting on a phone. The trailing \b keeps this from
  // swallowing real words: "hi+" cannot match "history" or "hire" because no
  // word boundary follows, and "yo" cannot match "your".
  if (/^(hi+|hey+|hel+o+|helo+|hlo+|hai|yo|hola|howdy|greetings?|good\s*(morning|afternoon|evening|day))\b/.test(t)) {
    return "Hello! I'm the RackTrack support assistant. Ask me anything about using RackTrack - scans, racks, switches, reports, your account - and I'll answer from our verified help content."
  }

  if (/^(thanks?|thank\s*you|ty|cheers)\b/.test(t)) {
    return "You're welcome! Let me know if there's anything else I can help with."
  }

  const mathMatch = t.match(/^(?:what\s+is\s+|calculate\s+|compute\s+|solve\s+)?(-?\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(-?\d+(?:\.\d+)?)\s*[?]?$/)
  if (mathMatch) {
    const a = parseFloat(mathMatch[1])
    const op = mathMatch[2]
    const b = parseFloat(mathMatch[3])
    let result
    switch (op) {
      case '+': result = a + b; break
      case '-': result = a - b; break
      case '*': case 'x': case '×': result = a * b; break
      case '/': result = b !== 0 ? a / b : null; break
    }
    if (result === null) return 'You cannot divide by zero.'
    if (result !== undefined) {
      const shown = Number.isInteger(result) ? result : Math.round(result * 1e6) / 1e6
      return `${a} ${op === 'x' || op === '×' ? '×' : op} ${b} = ${shown}`
    }
  }

  if (/^(who|what)\s+are\s+you/.test(t)) {
    return "I'm the RackTrack support assistant. I answer questions about RackTrack from verified help content, and I'll tell you when something is outside that."
  }

  if (/\b(what\s*(time|day|date)\s*is\s*(it|today)|what\s*is\s*(today|the\s*(time|day|date))|current\s*(time|date|day)|today'?s?\s*date)\b/.test(t)) {
    const now = new Date()
    return `The current date and time is ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}.`
  }

  return null
}

/** Trim match objects down to what a caller or log actually needs. */
function summarize(matches) {
  return matches.map((m) => ({
    id: m.entry.id,
    question: m.entry.question,
    confidence: m.confidence,
    audience: m.entry.audience,
  }))
}

export { THRESHOLDS }
