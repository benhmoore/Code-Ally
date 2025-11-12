# ProgressMonitor Design

## Purpose
Detect tool call patterns that suggest diminishing returns or inefficiency, complementing CycleDetector's exact duplicate detection.

## Detection Capabilities

### 1. Repeated File Access (Same File, Different Arguments)
**Pattern:** Reading same file multiple times with varying offsets/parameters
**Metric:** Track file_path access count
**Threshold:** 5+ accesses to same file
**Warning:** "You've read {file} 5 times. Consider if you already have the information you need."
**Confidence:** High

### 2. Similar Tool Calls (Fuzzy Duplicates)
**Pattern:** Tool calls that are similar but not identical (e.g., grep with slight variations)
**Metric:** Fuzzy matching on tool signatures
**Threshold:** 3+ similar calls
**Warning:** "You're making similar searches repeatedly. Consider refining your approach."
**Confidence:** Medium

### 3. Search Hit Rate / Diminishing Returns
**Pattern:** Searches increasingly returning no results
**Metric:** Track hits/misses for grep/glob
**Threshold:** <30% hit rate over last 5 searches
**Warning:** "Recent searches yielding few results. Consider different search terms."
**Confidence:** Medium

### 4. Scope Creep (Exploration Breadth)
**Pattern:** Accessing files across many different directories
**Metric:** Track unique top-level directories
**Threshold:** >5 different top-level dirs (for specialized agents)
**Warning:** "Exploring many areas. Consider focusing on most relevant parts."
**Confidence:** Low-Medium

### 5. Empty Result Streaks
**Pattern:** Consecutive searches with zero results
**Metric:** Track consecutive empty results
**Threshold:** 3+ consecutive empty grep/glob results
**Warning:** "Multiple searches with no results. Try different search strategy."
**Confidence:** High

## Interface

```typescript
interface DetectionIssue {
  issueType: 'exact_cycle' | 'repeated_file' | 'similar_calls' |
              'low_hit_rate' | 'scope_creep' | 'empty_streak';
  severity: 'high' | 'medium' | 'low';
  message: string;
  toolCallId?: string; // If tied to specific call
  metadata?: {
    count?: number;
    filePath?: string;
    hitRate?: number;
    dirCount?: number;
  };
}

class ProgressMonitor {
  // Called before tool execution to detect patterns
  detectIssues(toolCalls: ToolCall[]): DetectionIssue[];

  // Called after tool execution to update metrics
  recordToolCalls(toolCalls: ToolCall[], results: ToolResult[]): void;

  // Reset on new user input
  clearOnNewTurn(): void;

  // Get current metrics (for debugging/monitoring)
  getMetrics(): ProgressMetrics;
}
```

## Integration with Existing System

### Agent.ts Changes
```typescript
class Agent {
  private cycleDetector: CycleDetector; // Existing
  private progressMonitor: ProgressMonitor; // NEW

  async processToolCalls(toolCalls) {
    // Combine detection from both sources
    const exactCycles = this.cycleDetector.detectCycles(toolCalls);
    const progressIssues = this.progressMonitor.detectIssues(toolCalls);

    // Convert to unified format
    const allIssues = this.combineDetectionResults(exactCycles, progressIssues);

    // Pass to orchestrator
    await this.orchestrator.executeToolCalls(toolCalls, allIssues);

    // Record after execution (both detectors need results)
    this.cycleDetector.recordToolCalls(toolCalls);
    this.progressMonitor.recordToolCalls(toolCalls, results);
  }
}
```

### ToolOrchestrator.ts Changes
```typescript
class ToolOrchestrator {
  // Changed from cycles-only to general issues
  private detectionIssues: Map<string, DetectionIssue[]> = new Map();

  async executeToolCalls(
    toolCalls: ToolCall[],
    issues?: Map<string, DetectionIssue[]>
  ): Promise<void> {
    this.detectionIssues = issues || new Map();
    // ... rest of execution
  }

  private injectSystemReminders(result, toolCallId) {
    // Inject warnings for all detected issues
    const issues = this.detectionIssues.get(toolCallId);
    if (issues) {
      for (const issue of issues) {
        if (issue.severity === 'high') {
          injectSystemReminder(issue.message, issue.issueType);
        }
      }
    }
  }
}
```

## Metrics Tracked

```typescript
interface ProgressMetrics {
  // File access patterns
  fileAccessCount: Map<string, number>;

  // Search effectiveness
  searchMetrics: {
    totalSearches: number;
    emptyResults: number;
    consecutiveEmpty: number;
  };

  // Scope tracking
  uniqueTopLevelDirs: Set<string>;

  // Recent tool calls for similarity detection
  recentCalls: ToolCallHistoryEntry[];
}
```

## Severity-Based Intervention

**High Severity** (inject immediately):
- Exact cycles (from CycleDetector)
- 5+ accesses to same file
- 3+ consecutive empty searches

**Medium Severity** (inject if 2+ medium signals):
- Similar tool calls (3+)
- Low hit rate (<30%)
- Moderate scope creep

**Low Severity** (track but don't warn yet):
- Early scope exploration
- Single empty result

## Why This Design?

1. **Separation of Concerns:**
   - CycleDetector: Exact duplicates + file modification
   - ProgressMonitor: Patterns, metrics, trends

2. **Minimal Changes to Existing Code:**
   - CycleDetector stays as-is
   - Agent.ts: Add progressMonitor, combine results
   - ToolOrchestrator.ts: Generalize from cycles to issues

3. **Unified Warning System:**
   - Both detectors produce DetectionIssue[]
   - Single injection point in ToolOrchestrator
   - Consistent warning format

4. **Extensible:**
   - Easy to add new detection patterns to ProgressMonitor
   - Easy to adjust thresholds
   - Can add oracle integration later

5. **Backward Compatible:**
   - Existing CycleDetector behavior unchanged
   - New detections are additive
