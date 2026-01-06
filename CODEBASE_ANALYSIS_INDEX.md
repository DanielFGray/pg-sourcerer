# pg-sourcerer Codebase Analysis Index

This directory contains comprehensive analysis of the pg-sourcerer codebase focusing on Effect framework patterns and dependency injection architecture.

## Documents

### 1. EXPLORATION_SUMMARY.md (Quick Reference)
**Purpose**: High-level overview of the codebase exploration
**Audience**: Everyone
**Length**: ~300 lines

**Contents**:
- What was explored (scope)
- Key files analyzed with descriptions
- Architecture findings (what's working, what needs improvement)
- Dependency and data flow diagrams
- Specific code examples with line numbers
- Prioritized recommendations

**Start here if**: You want a quick understanding of the service architecture and main issues

---

### 2. EFFECT_DI_ANALYSIS.md (Deep Dive)
**Purpose**: Detailed technical analysis of Effect DI patterns
**Audience**: Senior engineers, architects, Effect experts
**Length**: ~550 lines

**Contents**:
- Each service definition with detailed analysis
- Context.Tag pattern usage (7 services analyzed)
- Effect.Service pattern usage
- Prop-drilling explanation and examples
- IR Builder parameter passing patterns
- Layer composition patterns (good and bad examples)
- 8 concrete examples showing impact
- Before/after refactoring comparisons
- Recommended refactoring priority matrix

**Start here if**: You're doing the actual refactoring or want to understand the patterns deeply

---

### 3. EFFECT_STYLE.md (Existing Reference)
**Purpose**: Style guide for Effect code in this project
**Audience**: All developers
**Note**: This is the existing style guide referenced in AGENTS.md

---

## Quick Navigation

### By Question

**Q: "What services exist and how are they structured?"**
→ See EXPLORATION_SUMMARY.md § "Key Files Analyzed - Service Definitions"
→ See EFFECT_DI_ANALYSIS.md § "1. Current Service Architecture"

**Q: "Where is prop-drilling happening?"**
→ See EXPLORATION_SUMMARY.md § "What Needs Improvement - PluginContext is prop-drilling"
→ See EFFECT_DI_ANALYSIS.md § "2. Prop-Drilling: The Main Opportunity"

**Q: "How should I refactor services to use Effect DI?"**
→ See EFFECT_DI_ANALYSIS.md § "8. Concrete Examples of Prop-Drilling Impact"
→ See EFFECT_DI_ANALYSIS.md § "10. Recommended Refactoring Priority"

**Q: "How are layers composed in tests?"**
→ See EXPLORATION_SUMMARY.md § "Test Patterns are Strong"
→ See EFFECT_DI_ANALYSIS.md § "4. Where Layering Is Good"

**Q: "What's wrong with the current PluginContext?"**
→ See EFFECT_DI_ANALYSIS.md § "2. Prop-Drilling: The Main Opportunity - THE PROBLEM: PluginContext"

**Q: "What specific functions have parameter passing issues?"**
→ See EFFECT_DI_ANALYSIS.md § "3. IR Builder: Parameter Passing in Pure Functions"
→ See EXPLORATION_SUMMARY.md § "Specific Code Examples"

---

## Service Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Well-Implemented Services                │
├─────────────────────────────────────────────────────────────┤
│ ✅ Inflection       - Context.Tag, Live/Stub layers        │
│ ✅ Emissions        - Context.Tag, fresh per run             │
│ ✅ Symbols          - Context.Tag, fresh per run             │
│ ✅ TypeHints        - Context.Tag, parametric factory        │
│ ✅ FileWriter       - Context.Tag, @effect/platform dep      │
│ ✅ IRBuilder        - Context.Tag, depends on Inflection     │
│ ✅ PluginRunner     - Effect.Service pattern                 │
│ ✅ ConfigLoader     - Context.Tag, lilconfig integration     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                     Services with Issues                     │
├─────────────────────────────────────────────────────────────┤
│ ⚠️ Introspection    - Service tag exists but NO Layer        │
│                       Bypasses DI entirely                    │
│                                                              │
│ ⚠️ PluginContext    - Opaque object (prop-drilling)          │
│                       8 dependencies manually wrapped         │
│                                                              │
│ ⚠️ IR Builder       - Pure functions pass inflection         │
│                       through 4+ parameter levels            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                 Correctly-Scoped Services                    │
├─────────────────────────────────────────────────────────────┤
│ ✅ SmartTagsParser  - Pure function (no service needed)      │
│                       Wrapped in Effect for errors            │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Findings

### 1. Good Practices Used
- Context.Tag pattern for service definitions
- Both Live and Stub layer implementations
- Modern Effect.Service pattern in PluginRunner
- @effect/vitest layer() wrapper in tests
- Pure functions with Effect for error handling

### 2. Main Issues
- **PluginContext** creates artificial wrapper instead of using Effect DI
- **Introspection** has service tag but no Layer, completely bypasses DI
- **IR Builder** passes inflection parameter through multiple function layers
- **Parameter passing** throughout IR builder indicates missing context

### 3. Impact
- Adding new services requires modifying PluginContext interface and all callers
- Parameter passing makes functions harder to read and extend
- Inconsistent use of DI (some services use it, introspection bypasses it)
- Test setup requires stubbing entire PluginContext object

---

## Refactoring Roadmap

### Phase 1: Foundation (High Priority)
1. Create DatabaseIntrospectionLive Layer and use in context
   - **Why**: Completes the pattern, makes all services consistent
   - **Effort**: Small
   - **Impact**: High

2. Convert Plugin interface to Effect-based dependencies
   - **Why**: Main architectural improvement
   - **Effort**: Medium
   - **Impact**: High

3. Move inflection to Effect context in IR builder
   - **Why**: Eliminates parameter passing
   - **Effort**: Medium
   - **Impact**: Medium

### Phase 2: Optimization (Medium Priority)
4. Extract reusable test layer bundles
   - **Why**: Reduce test boilerplate
   - **Effort**: Small
   - **Impact**: Low-Medium

5. Review ConfigLoader lazy initialization
   - **Why**: Better resource management
   - **Effort**: Small
   - **Impact**: Low

### Phase 3: Future Work
6. Metrics/logging service layers
7. Auto-discovery or service registry pattern

---

## Code Statistics

| Service | Lines | Status | Main Issue |
|---------|-------|--------|-----------|
| inflection.ts | 240 | ✅ Good | None |
| plugin-context.ts | 123 | ⚠️ Issue | Prop-drilling |
| plugin-runner.ts | 346 | ✅ Good | Uses PluginContext |
| emissions.ts | 134 | ✅ Good | None |
| symbols.ts | 238 | ✅ Good | None |
| type-hints.ts | 177 | ✅ Good | None |
| file-writer.ts | 149 | ✅ Good | None |
| ir-builder.ts | 500+ | ⚠️ Issue | Parameter passing |
| config-loader.ts | 163 | ✅ Good | Minor: Eager init |
| introspection.ts | 150 | ⚠️ Issue | Bypasses DI |
| smart-tags-parser.ts | 150+ | ✅ Good | None |
| **Total** | **~2300** | | |

---

## Files Referenced in Analysis

### Service Files
- `src/services/inflection.ts`
- `src/services/plugin-context.ts`
- `src/services/plugin-runner.ts`
- `src/services/emissions.ts`
- `src/services/symbols.ts`
- `src/services/type-hints.ts`
- `src/services/file-writer.ts`
- `src/services/ir-builder.ts`
- `src/services/config-loader.ts`
- `src/services/introspection.ts`
- `src/services/smart-tags-parser.ts`

### IR and Configuration
- `src/ir/semantic-ir.ts`
- `src/ir/smart-tags.ts`
- `src/config.ts`
- `src/index.ts` (exports)

### Tests
- `src/__tests__/plugin-runner.test.ts`
- `src/__tests__/ir-builder.integration.test.ts`
- `src/__tests__/type-hints.test.ts`
- `src/__tests__/symbols.test.ts`

---

## How to Use These Documents

### For Code Review
1. Start with EXPLORATION_SUMMARY.md to understand context
2. Reference EFFECT_DI_ANALYSIS.md for specific patterns
3. Check line numbers for exact code locations

### For Refactoring
1. Read EFFECT_DI_ANALYSIS.md § "10. Recommended Refactoring Priority"
2. For each item, reference the concrete examples section
3. Follow "The Better Way" suggestions for implementation

### For Onboarding
1. Read EXPLORATION_SUMMARY.md quick reference
2. Skim EFFECT_DI_ANALYSIS.md for architecture overview
3. Reference EFFECT_STYLE.md for coding conventions

### For Architecture Discussions
1. Share EXPLORATION_SUMMARY.md for quick alignment
2. Reference specific findings from EFFECT_DI_ANALYSIS.md
3. Use service overview diagrams for visualization

---

## Document Statistics

| Document | Lines | Sections | Focus |
|----------|-------|----------|-------|
| EXPLORATION_SUMMARY.md | ~280 | 12 | Overview, quick ref |
| EFFECT_DI_ANALYSIS.md | ~547 | 10 | Deep dive, patterns |
| CODEBASE_ANALYSIS_INDEX.md | This file | Navigation | Index & guide |

---

## Key Metrics Tracked

**Services analyzed**: 11 services
**Files analyzed**: 20+ files
**Lines of code reviewed**: ~2,300 lines
**Issues identified**: 5 main issues
**Opportunities found**: 10+ refactoring opportunities
**Code examples**: 15+ concrete examples with line numbers

---

## Generated By

This analysis was generated through systematic exploration of:
1. Service definition files
2. Layer composition patterns
3. Test file patterns
4. Configuration and initialization
5. Data flow through the system
6. Dependency injection usage

Analysis date: January 6, 2025
Codebase: pg-sourcerer packages/sourcerer-rewrite
Focus: Effect framework patterns and DI architecture

---

## Next Steps

1. **For architecture**: Review EFFECT_DI_ANALYSIS.md and discuss refactoring priority
2. **For implementation**: Start with Phase 1 items in refactoring roadmap
3. **For understanding**: Run through Quick Navigation section for specific questions
4. **For onboarding**: Use "How to Use These Documents" section

---

## Related Documentation

See also:
- EFFECT_STYLE.md - Code style guide for this project
- ARCHITECTURE.md - High-level architecture plan
- AGENTS.md - Agent instructions and tooling

