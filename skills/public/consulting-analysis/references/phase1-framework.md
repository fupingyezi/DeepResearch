# Phase 1: Analysis Framework Generation

## Purpose

Given a **research subject** (e.g., "Gen-Z Skincare Market Analysis", "NEV Industry Competitive Landscape", "Brand X Consumer Profiling"), produce a complete **analysis framework** that serves as the blueprint for downstream data collection and final report generation.

## Phase 1 Inputs

| Input                   | Description                                                                         | Required |
| ----------------------- | ----------------------------------------------------------------------------------- | -------- |
| **Research Subject**    | The topic or question to be analyzed                                                | Yes      |
| **Scope / Constraints** | Geographic scope, time range, industry segment, target audience, etc.               | Optional |
| **Specific Angles**     | Any particular angles or hypotheses the user wants explored                         | Optional |
| **Domain**              | The analytical domain: market, finance, industry, brand, consumer, investment, etc. | Inferred |

## Phase 1 Workflow

### Step 1.1: Understand the Research Subject

- Parse the research subject to identify the **core entity** (market, brand, product, industry, consumer segment, financial instrument, etc.)
- Identify the **analytical domain** (marketing, finance, industry, competitive, consumer, investment, macro, etc.)
- Determine the **natural analytical dimensions** based on domain:

| Domain                   | Typical Dimensions                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Market Analysis          | Market size, growth trends, market segmentation, growth drivers, competitive landscape, consumer profiling      |
| Brand Analysis           | Brand positioning, market share, consumer perception, marketing strategy, competitor comparison                 |
| Consumer Insights        | Demographic profiling, purchase behavior, decision journey, pain points, scenario analysis                      |
| Financial Analysis       | Macro environment, industry trends, company fundamentals, financial metrics, valuation, risk assessment         |
| Industry Research        | Value chain analysis, market size, competitive landscape, policy environment, technology trends, entry barriers |
| Investment Due Diligence | Business model, financial health, management assessment, market opportunity, risk factors, exit pathways        |
| Competitive Intelligence | Competitor identification, strategic comparison, SWOT analysis, differentiated positioning, market dynamics     |

### Step 1.2: Select Analysis Frameworks & Models

Based on the identified domain and research subject, select **one or more** professional analysis frameworks to structure the reasoning in each chapter. The chosen frameworks guide the **Analysis Logic** in the chapter skeleton (Step 1.3).

#### Strategic & Environmental Analysis

| Framework                  | Description                                                                                                        | Best For                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **SWOT Analysis**          | Strengths, Weaknesses, Opportunities, Threats                                                                      | Brand assessment, competitive positioning, strategic planning                    |
| **PEST / PESTEL Analysis** | Political, Economic, Social, Technological (+ Environmental, Legal)                                                | Macro-environment scanning, market entry assessment, policy impact analysis      |
| **Porter's Five Forces**   | Supplier bargaining power, buyer bargaining power, threat of new entrants, threat of substitutes, industry rivalry | Industry competitive landscape, entry barrier assessment, profit margin analysis |
| **Porter's Diamond Model** | Factor conditions, demand conditions, related industries, firm strategy & structure                                | National/regional competitive advantage analysis                                 |
| **VRIO Analysis**          | Value, Rarity, Imitability, Organization                                                                           | Core competency assessment, resource advantage analysis                          |

#### Market & Growth Analysis

| Framework                            | Description                                                                  | Best For                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **STP Analysis**                     | Segmentation, Targeting, Positioning                                         | Market segmentation, target market selection, brand positioning |
| **BCG Matrix (Growth-Share Matrix)** | Stars, Cash Cows, Question Marks, Dogs                                       | Product portfolio management, resource allocation decisions     |
| **Ansoff Matrix**                    | Market penetration, market development, product development, diversification | Growth strategy selection                                       |
| **Product Life Cycle (PLC)**         | Introduction, growth, maturity, decline                                      | Product strategy formulation, market timing decisions           |
| **TAM-SAM-SOM**                      | Total / Serviceable / Obtainable Market                                      | Market sizing, opportunity quantification                       |
| **Technology Adoption Lifecycle**    | Innovators → Early Adopters → Early Majority → Late Majority → Laggards      | Emerging technology/category penetration analysis               |

#### Consumer & Behavioral Analysis

| Framework                         | Description                                                   | Best For                                                |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| **Consumer Decision Journey**     | Awareness → Consideration → Evaluation → Purchase → Loyalty   | Consumer behavior path mapping, touchpoint optimization |
| **AARRR Funnel (Pirate Metrics)** | Acquisition, Activation, Retention, Revenue, Referral         | User growth analysis, conversion rate optimization      |
| **RFM Model**                     | Recency, Frequency, Monetary                                  | Customer value segmentation, precision marketing        |
| **Maslow's Hierarchy of Needs**   | Physiological → Safety → Social → Esteem → Self-actualization | Consumer psychology analysis, product value proposition |
| **Jobs-to-be-Done (JTBD)**        | The "job" a user needs to accomplish in a specific context    | Demand insight, product innovation direction            |

#### Financial & Valuation Analysis

| Framework                       | Description                                                  | Best For                                                |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| **DuPont Analysis**             | ROE = Net Profit Margin × Asset Turnover × Equity Multiplier | Profitability decomposition, financial health diagnosis |
| **DCF (Discounted Cash Flow)**  | Free cash flow discounting                                   | Enterprise/project valuation                            |
| **Comparable Company Analysis** | PE, PB, PS, EV/EBITDA multiples comparison                   | Relative valuation, peer benchmarking                   |
| **EVA (Economic Value Added)**  | After-tax operating profit - Cost of capital                 | Value creation capability assessment                    |

#### Competitive & Strategic Positioning

| Framework                   | Description                                                        | Best For                                                           |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Benchmarking**            | Key performance indicator item-by-item comparison                  | Competitor gap analysis, best practice identification              |
| **Strategic Group Mapping** | Cluster competitors along two key dimensions                       | Competitive landscape visualization, white-space identification    |
| **Value Chain Analysis**    | Primary activities + support activities value decomposition        | Cost advantage sources, differentiation opportunity identification |
| **Blue Ocean Strategy**     | Value curve, four-action framework (Eliminate-Reduce-Raise-Create) | Differentiated innovation, new market space creation               |
| **Perceptual Mapping**      | Plot brand positions along two consumer-perceived dimensions       | Brand positioning analysis, market gap discovery                   |

#### Industry & Supply Chain Analysis

| Framework                | Description                                                                                                                       | Best For                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Industry Value Chain** | Upstream → Midstream → Downstream decomposition                                                                                   | Industry structure understanding, profit distribution analysis |
| **Gartner Hype Cycle**   | Technology Trigger → Peak of Inflated Expectations → Trough of Disillusionment → Slope of Enlightenment → Plateau of Productivity | Emerging technology maturity assessment                        |
| **GE-McKinsey Matrix**   | Industry Attractiveness × Competitive Strength                                                                                    | Business portfolio prioritization, investment decisions        |

#### Selection Principles

1. **Domain-First**: Based on the domain identified in Step 1.1, select **2-4** most relevant frameworks from the toolkit above
2. **Complementary**: Choose complementary rather than overlapping frameworks (e.g., macro-level with PESTEL + micro-level with Porter's Five Forces)
3. **Depth over Breadth**: Better to deeply apply 2 frameworks than superficially stack 6
4. **Data-Feasible**: Selected frameworks must be supportable by downstream data collection skills — if the data required by a framework cannot be reasonably obtained, downgrade or substitute
5. **Explicit Mapping**: In the chapter skeleton, explicitly annotate which framework each chapter uses and how it is applied

#### Framework Selection Output Format

```markdown
## Framework Selection

| Chapter                          | Selected Framework(s)                          | Application                                                                                              |
| -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Market Size & Growth Trends      | TAM-SAM-SOM + Product Life Cycle               | TAM-SAM-SOM to quantify market space, PLC to determine market stage                                      |
| Competitive Landscape Assessment | Porter's Five Forces + Strategic Group Mapping | Five Forces to assess industry competition intensity, Group Mapping to visualize competitive positioning |
| Consumer Profiling               | RFM + Consumer Decision Journey                | RFM to segment customer value, Decision Journey to identify key conversion nodes                         |
| Brand Strategy Recommendations   | SWOT + Blue Ocean Strategy                     | SWOT to summarize overall landscape, Blue Ocean to guide differentiation direction                       |
```

### Step 1.3: Design Chapter Skeleton

Produce a hierarchical chapter structure. Each chapter must include:

1. **Chapter Title** — Professional, concise, subject-based (follow titling constraints in Formatting section)
2. **Analysis Objective** — What this chapter aims to reveal
3. **Analysis Logic** — The reasoning chain or framework (must reference the frameworks selected in Step 1.2)
4. **Core Hypothesis** — Preliminary hypotheses to be validated or refuted by data

#### Chapter Skeleton Output Format

```markdown
## Analysis Framework

### Chapter 1: [Title]

- **Analysis Objective**: [This chapter aims to...]
- **Analysis Logic**: [Framework or reasoning chain used]
- **Core Hypothesis**: [Hypotheses to validate]
- **Data Requirements**: (see Step 1.4)
- **Visualization Plan**: (see Step 1.5)

### Chapter 2: [Title]

...
```

### Step 1.4: Define Data Query Requirements Per Chapter

For each chapter, specify **exactly what data needs to be collected**. This is the bridge to downstream data collection skills.

Each data requirement entry must include:

| Field                 | Description                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data Metric**       | The specific metric or data point needed (e.g., "China skincare market size 2020-2025 (in billion CNY)")                                          |
| **Data Type**         | Quantitative, Qualitative, or Mixed                                                                                                               |
| **Suggested Sources** | Suggested source categories: Industry reports, financial statements, government statistics, social media, e-commerce platforms, survey data, news |
| **Search Keywords**   | Suggested search queries for data collection agents                                                                                               |
| **Priority**          | P0 (Required) / P1 (Important) / P2 (Supplementary)                                                                                               |
| **Time Range**        | The time period the data should cover                                                                                                             |

#### Data Requirements Output Format (per chapter)

```markdown
#### Data Requirements

| #   | Data Metric                 | Data Type    | Suggested Sources                       | Search Keywords                                 | Priority | Time Range  |
| --- | --------------------------- | ------------ | --------------------------------------- | ----------------------------------------------- | -------- | ----------- |
| 1   | Market size (billion CNY)   | Quantitative | Industry reports, government statistics | "China skincare market size 2024"               | P0       | 2020-2025   |
| 2   | CAGR                        | Quantitative | Industry reports                        | "skincare CAGR growth rate"                     | P0       | 2020-2025   |
| 3   | Sub-category share          | Quantitative | E-commerce platforms, industry reports  | "skincare category share cream serum sunscreen" | P1       | Latest      |
| 4   | Policy & regulatory updates | Qualitative  | Government announcements, news          | "cosmetics regulation 2024"                     | P2       | Past 1 year |
```

### Step 1.5: Define Visualization & Content Structure Per Chapter

For each chapter, specify the **planned visualization** and **content structure** for the final report:

| Field                          | Description                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Visualization Type**         | Chart type: Line chart, bar chart, pie chart, scatter plot, radar chart, heatmap, Sankey diagram, comparison table, etc. |
| **Visualization Title**        | Descriptive title for the chart                                                                                          |
| **Visualization Data Mapping** | Which data indicators map to X/Y axes or segments                                                                        |
| **Comparison Table Design**    | Column headers and comparison dimensions for the data contrast table                                                     |
| **Argument Structure**         | The planned "What → Why → So What" narrative outline                                                                     |

#### Visualization Plan Output Format (per chapter)

```markdown
#### Visualization & Content Plan

**Chart 1**: [Type] — [Title]

- X-axis: [Dimension], Y-axis: [Metric]
- Data source: Corresponds to Data Requirement #1, #2

**Comparison Table**:
| Dimension | Item A | Item B | Item C |
|-----------|--------|--------|--------|

**Argument Structure**:

1. **Observation (What)**: [Surface phenomenon revealed by data]
2. **Attribution (Why)**: [Driving factors or underlying causes]
3. **Implication (So What)**: [Strategic implications or recommended actions]
```

### Step 1.6: Output Complete Analysis Framework

Assemble all outputs into a single, structured **Analysis Framework Document**:

```markdown
# [Research Subject] Analysis Framework

## Research Overview

- **Research Subject**: [...]
- **Scope**: [Geography, time range, industry segment]
- **Analysis Domain**: [Market / Finance / Industry / Brand / Consumer / ...]
- **Core Research Questions**: [1-3 key questions]

## Framework Selection

| Chapter | Selected Framework(s) | Application |
| ------- | --------------------- | ----------- |
| ...     | ...                   | ...         |

## Chapter Skeleton

### 1. [Chapter Title]

- **Analysis Objective**: [...]
- **Analysis Logic**: [...]
- **Core Hypothesis**: [...]

#### Data Requirements

| #   | Data Metric | Data Type | Suggested Sources | Search Keywords | Priority | Time Range |
| --- | ----------- | --------- | ----------------- | --------------- | -------- | ---------- |
| ... | ...         | ...       | ...               | ...             | ...      | ...        |

#### Visualization & Content Plan

[Chart plan + Comparison table design + Argument structure]

### 2. [Chapter Title]

...

### N. [Chapter Title]

...

## Data Collection Task List

[Consolidate all P0/P1 data requirements across chapters into a structured task list for downstream data collection skills to execute]
```

## Phase 1 Quality Checklist

- [ ] Analysis framework covers all natural dimensions for the identified domain
- [ ] 2-4 professional analysis frameworks are selected and explicitly mapped to chapters
- [ ] Selected frameworks are complementary (not overlapping) and data-feasible
- [ ] Each chapter has clear Analysis Objective, Analysis Logic (referencing chosen framework), and Core Hypothesis
- [ ] Data requirements are specific, measurable, and include search keywords
- [ ] Every chapter has at least one visualization plan
- [ ] Data priorities (P0/P1/P2) are assigned realistically
- [ ] The framework is actionable — a data collection agent can execute on the Search Keywords directly
- [ ] Data Collection Task List is comprehensive and deduplicated
