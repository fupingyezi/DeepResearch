# Review Output Template & Adaptations

## Review Output Template

```markdown
# Paper Review: [Paper Title]

## Paper Metadata

- **Authors**: [Author list]
- **Venue**: [Publication venue or preprint server]
- **Year**: [Year]
- **Domain**: [Research field]
- **Paper Type**: [Empirical / Theoretical / Survey / Systems / Position]

## Executive Summary

[2-3 paragraph summary of the paper's core contribution, approach, and main findings.
State your overall assessment upfront: what the paper does well, where it falls short,
and whether the contribution is sufficient for the claimed venue/impact level.]

## Summary of Contributions

1. [First claimed contribution — one sentence]
2. [Second claimed contribution — one sentence]
3. [Additional contributions if any]

## Strengths

### S1: [Concise strength title]

[Detailed explanation with specific references to sections, figures, or tables in the paper.
Explain WHY this is a strength and its significance.]

### S2: [Concise strength title]

[...]

### S3: [Concise strength title]

[...]

## Weaknesses

### W1: [Concise weakness title]

[Detailed explanation with specific references. Explain the impact of this weakness on
the paper's claims. Suggest how it could be addressed.]

### W2: [Concise weakness title]

[...]

### W3: [Concise weakness title]

[...]

## Methodology Assessment

| Criterion           | Rating (1-5) | Assessment            |
| ------------------- | :----------: | --------------------- |
| Soundness           |      X       | [Brief justification] |
| Novelty             |      X       | [Brief justification] |
| Reproducibility     |      X       | [Brief justification] |
| Experimental Design |      X       | [Brief justification] |
| Statistical Rigor   |      X       | [Brief justification] |
| Scalability         |      X       | [Brief justification] |

## Questions for the Authors

1. [Specific question that would clarify a concern or ambiguity]
2. [Question about methodology choices or alternative approaches]
3. [Question about generalizability or practical applicability]

## Minor Issues

- [Typos, formatting issues, unclear figures, notation inconsistencies]
- [Missing references that should be cited]
- [Suggestions for improved clarity]

## Literature Positioning

[How does this work relate to the current state of the art?
Are key related works cited? Are comparisons fair and comprehensive?
What important related work is missing?]

## Recommendations

**Overall Assessment**: [Accept / Weak Accept / Borderline / Weak Reject / Reject]

**Confidence**: [High / Medium / Low] — [Justification for confidence level]

**Contribution Level**: [Landmark / Significant / Moderate / Marginal / Below threshold]

### Actionable Suggestions for Improvement

1. [Specific, constructive suggestion]
2. [Specific, constructive suggestion]
3. [Specific, constructive suggestion]
```

## Adaptation by Paper Type

| Paper Type      | Focus Areas                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Empirical**   | Experimental design, baselines, statistical significance, ablations, reproducibility           |
| **Theoretical** | Proof correctness, assumption reasonableness, tightness of bounds, connection to practice      |
| **Survey**      | Comprehensiveness, taxonomy quality, coverage of recent work, synthesis insights               |
| **Systems**     | Architecture decisions, scalability evidence, real-world deployment, engineering contributions |
| **Position**    | Argument coherence, evidence for claims, impact potential, fairness of characterizations       |

## Quality Checklist

Before finalizing the review, verify:

- [ ] Paper was read completely (not just abstract and introduction)
- [ ] All major claims are identified and evaluated against evidence
- [ ] At least 3 strengths and 3 weaknesses are provided with specific references
- [ ] The methodology assessment table is complete with ratings and justifications
- [ ] Questions for authors target genuine ambiguities, not rhetorical critiques
- [ ] Literature search was conducted to contextualize the contribution
- [ ] Recommendations are actionable and constructive
- [ ] The overall assessment is consistent with the identified strengths and weaknesses
- [ ] The review tone is professional and respectful
- [ ] Minor issues are separated from major concerns
