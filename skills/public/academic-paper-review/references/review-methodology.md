# Review Methodology

## Phase 1: Paper Comprehension

Thoroughly read and understand the paper before forming any judgments.

### Step 1.1: Identify Paper Metadata

Extract and record:

| Field              | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| **Title**          | Full paper title                                                    |
| **Authors**        | Author list and affiliations                                        |
| **Venue / Status** | Publication venue, preprint server, or submission status            |
| **Year**           | Publication or submission year                                      |
| **Domain**         | Research field and subfield                                         |
| **Paper Type**     | Empirical, theoretical, survey, position paper, systems paper, etc. |

### Step 1.2: Deep Reading Pass

Read the paper systematically:

1. **Abstract & Introduction** — Identify the claimed contributions and motivation
2. **Related Work** — Note how authors position their work relative to prior art
3. **Methodology** — Understand the proposed approach, model, or framework in detail
4. **Experiments / Results** — Examine datasets, baselines, metrics, and reported outcomes
5. **Discussion & Limitations** — Note any self-identified limitations
6. **Conclusion** — Compare concluded claims against actual evidence presented

### Step 1.3: Key Claims Extraction

List the paper's main claims explicitly:

```
Claim 1: [Specific claim about contribution or finding]
Evidence: [What evidence supports this claim in the paper]
Strength: [Strong / Moderate / Weak]

Claim 2: [...]
...
```

## Phase 2: Critical Analysis

### Step 2.1: Literature Context Search

Use web search to understand the research landscape:

```
Search queries:
- "[paper topic] state of the art [current year]"
- "[key method name] comparison benchmark"
- "[authors] previous work [topic]"
- "[specific technique] limitations criticism"
- "survey [research area] recent advances"
```

Use `web_fetch` on key related papers or surveys to understand where this work fits.

### Step 2.2: Methodology Assessment

Evaluate the methodology using the following framework:

| Criterion               | Questions to Ask                                                           | Rating |
| ----------------------- | -------------------------------------------------------------------------- | ------ |
| **Soundness**           | Is the approach technically correct? Are there logical flaws?              | 1-5    |
| **Novelty**             | What is genuinely new vs. incremental improvement?                         | 1-5    |
| **Reproducibility**     | Are details sufficient to reproduce? Code/data available?                  | 1-5    |
| **Experimental Design** | Are baselines fair? Are ablations adequate? Are datasets appropriate?      | 1-5    |
| **Statistical Rigor**   | Are results statistically significant? Error bars reported? Multiple runs? | 1-5    |
| **Scalability**         | Does the approach scale? Are computational costs discussed?                | 1-5    |

### Step 2.3: Contribution Significance Assessment

Evaluate the significance level:

| Level               | Description                                        | Criteria                                     |
| ------------------- | -------------------------------------------------- | -------------------------------------------- |
| **Landmark**        | Fundamentally changes the field                    | New paradigm, widely applicable breakthrough |
| **Significant**     | Strong contribution advancing the state of the art | Clear improvement with solid evidence        |
| **Moderate**        | Useful contribution with some limitations          | Incremental but valid improvement            |
| **Marginal**        | Minimal advance over existing work                 | Small gains, narrow applicability            |
| **Below threshold** | Does not meet publication standards                | Fundamental flaws, insufficient evidence     |

### Step 2.4: Strengths and Weaknesses Analysis

For each strength or weakness, provide:

- **What**: Specific observation
- **Where**: Section/figure/table reference
- **Why it matters**: Impact on the paper's claims or utility

## Phase 3: Review Synthesis

### Step 3.1: Assemble the Structured Review

Produce the final review using the template in `review-template.md`.

## Review Principles

### Constructive Criticism

- **Always suggest how to fix it** — Don't just point out problems; propose solutions
- **Give credit where due** — Acknowledge genuine contributions even in flawed papers
- **Be specific** — Reference exact sections, equations, figures, and tables
- **Separate minor from major** — Distinguish fatal flaws from fixable issues

### Objectivity Standards

- ❌ "This paper is poorly written" (vague, unhelpful)
- ✅ "Section 3.2 introduces notation X without formal definition, making the proof in Theorem 1 difficult to follow. Consider adding a notation table after the problem formulation." (specific, actionable)

### Ethical Review Practices

- Do NOT dismiss work based on author reputation or affiliation
- Evaluate the work on its own merits
- Flag potential ethical concerns (bias in datasets, dual-use implications) constructively
- Maintain confidentiality of unpublished work

## Common Pitfalls to Avoid

- ❌ Reviewing the paper you wish was written instead of the paper that was submitted
- ❌ Demanding additional experiments that are unreasonable in scope
- ❌ Penalizing the paper for not solving a different problem
- ❌ Being overly influenced by writing quality versus technical contribution
- ❌ Treating absence of comparison to your own work as a weakness
- ❌ Providing only a summary without critical analysis
