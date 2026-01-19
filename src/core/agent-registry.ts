import type {
  ExtendedAgentDefinition,
  AgentCategory,
  AgentCapability,
  ToolConfig,
  RetryConfig,
  SecretReference,
} from '../agents/types.js';
import { ExtendedAgentDefinitionSchema, DEFAULT_RETRY_CONFIG } from '../agents/types.js';
import type { RawAgentConfig } from '../config/types.js';

// ============================================================================
// Agent Registry
// ============================================================================

interface AgentRegistryConfig {
  /** Default model for agents */
  defaultModel?: string;
  /** Default max execution time */
  defaultMaxExecutionTimeMs?: number;
  /** Default max turns */
  defaultMaxTurns?: number;
}

/**
 * Registry for managing agent definitions
 */
export class AgentRegistry {
  private agents: Map<string, ExtendedAgentDefinition> = new Map();
  private readonly defaultModel: string;
  private readonly defaultMaxExecutionTimeMs: number;
  private readonly defaultMaxTurns: number;

  constructor(config: AgentRegistryConfig = {}) {
    this.defaultModel = config.defaultModel ?? 'claude-sonnet-4-20250514';
    this.defaultMaxExecutionTimeMs = config.defaultMaxExecutionTimeMs ?? 300000; // 5 min
    this.defaultMaxTurns = config.defaultMaxTurns ?? 20;
  }

  /**
   * Register an agent definition
   */
  register(agent: ExtendedAgentDefinition): void {
    // Validate the agent definition
    const validated = ExtendedAgentDefinitionSchema.parse(agent);
    this.agents.set(validated.id, validated);
    console.log(`[AgentRegistry] Registered agent: ${validated.id}`);
  }

  /**
   * Register an agent from raw config (e.g., from chezmoi templates)
   */
  registerFromConfig(config: RawAgentConfig): void {
    const agent = this.configToDefinition(config);
    this.register(agent);
  }

  /**
   * Register multiple agents from configs
   */
  registerFromConfigs(configs: Map<string, RawAgentConfig>): void {
    for (const [id, config] of configs) {
      try {
        this.registerFromConfig(config);
      } catch (error) {
        console.error(`[AgentRegistry] Failed to register agent ${id}:`, error);
      }
    }
  }

  /**
   * Get an agent definition by ID
   */
  get(agentId: string): ExtendedAgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all registered agents
   */
  getAll(): ExtendedAgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by category
   */
  getByCategory(category: AgentCategory): ExtendedAgentDefinition[] {
    return this.getAll().filter(a => a.category === category);
  }

  /**
   * Get agents with a specific capability
   */
  getByCapability(capability: AgentCapability): ExtendedAgentDefinition[] {
    return this.getAll().filter(a => a.capabilities.includes(capability));
  }

  /**
   * Check if an agent exists
   */
  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Remove an agent from the registry
   */
  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  /**
   * Clear all registered agents
   */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Get agent IDs that a given agent can spawn
   */
  getAllowedSubagents(agentId: string): string[] {
    const agent = this.get(agentId);
    if (!agent || !agent.canSpawnSubagents) {
      return [];
    }

    // If allowedSubagents is specified, use it; otherwise return all agent IDs
    if (agent.allowedSubagents && agent.allowedSubagents.length > 0) {
      return agent.allowedSubagents.filter(id => this.has(id));
    }

    // Return all registered agents except the current one
    return this.getAll()
      .filter(a => a.id !== agentId)
      .map(a => a.id);
  }

  /**
   * Validate spawn permissions
   */
  canSpawn(parentAgentId: string, childAgentId: string): boolean {
    const parent = this.get(parentAgentId);
    if (!parent || !parent.canSpawnSubagents) {
      return false;
    }

    if (!this.has(childAgentId)) {
      return false;
    }

    if (parent.allowedSubagents && parent.allowedSubagents.length > 0) {
      return parent.allowedSubagents.includes(childAgentId);
    }

    return true;
  }

  /**
   * Check if spawning childAgentId from parentAgentId would create a cycle.
   *
   * This uses DFS to detect if there's a path from childAgentId back to
   * parentAgentId through the allowedSubagents graph.
   *
   * @param parentAgentId - The agent that wants to spawn
   * @param childAgentId - The agent to be spawned
   * @returns true if spawning would create a cycle, false otherwise
   */
  wouldCreateCycle(parentAgentId: string, childAgentId: string): boolean {
    // Direct self-spawn is always a cycle
    if (parentAgentId === childAgentId) {
      return true;
    }

    // Check if childAgentId can eventually spawn parentAgentId
    const visited = new Set<string>();
    return this.canReach(childAgentId, parentAgentId, visited);
  }

  /**
   * DFS helper to check if there's a path from startId to targetId.
   */
  private canReach(startId: string, targetId: string, visited: Set<string>): boolean {
    if (startId === targetId) {
      return true;
    }

    if (visited.has(startId)) {
      return false;
    }

    visited.add(startId);

    const subagents = this.getAllowedSubagents(startId);
    for (const subagentId of subagents) {
      if (this.canReach(subagentId, targetId, visited)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detect all cycles in the agent subagent graph.
   *
   * @returns Array of cycles, where each cycle is an array of agent IDs
   */
  detectAllCycles(): string[][] {
    const cycles: string[][] = [];
    const allVisited = new Set<string>();

    for (const agent of this.getAll()) {
      if (!agent.canSpawnSubagents) continue;

      const path: string[] = [];
      const pathSet = new Set<string>();

      this.findCyclesDfs(agent.id, path, pathSet, allVisited, cycles);
    }

    return cycles;
  }

  /**
   * DFS helper for cycle detection.
   */
  private findCyclesDfs(
    agentId: string,
    path: string[],
    pathSet: Set<string>,
    allVisited: Set<string>,
    cycles: string[][]
  ): void {
    // If we've already visited this in the current path, we found a cycle
    if (pathSet.has(agentId)) {
      // Extract the cycle from the path
      const cycleStartIndex = path.indexOf(agentId);
      if (cycleStartIndex >= 0) {
        const cycle = [...path.slice(cycleStartIndex), agentId];
        // Only add unique cycles
        const cycleKey = cycle.sort().join(',');
        if (!cycles.some(c => c.sort().join(',') === cycleKey)) {
          cycles.push(cycle);
        }
      }
      return;
    }

    // If we've fully explored this node before, skip
    if (allVisited.has(agentId)) {
      return;
    }

    path.push(agentId);
    pathSet.add(agentId);

    const subagents = this.getAllowedSubagents(agentId);
    for (const subagentId of subagents) {
      this.findCyclesDfs(subagentId, path, pathSet, allVisited, cycles);
    }

    path.pop();
    pathSet.delete(agentId);
    allVisited.add(agentId);
  }

  /**
   * Validate spawn with cycle detection.
   *
   * @param parentAgentId - The agent that wants to spawn
   * @param childAgentId - The agent to be spawned
   * @returns Object with allowed status and reason if not allowed
   */
  validateSpawn(parentAgentId: string, childAgentId: string): { allowed: boolean; reason?: string } {
    if (!this.canSpawn(parentAgentId, childAgentId)) {
      return {
        allowed: false,
        reason: `Agent '${parentAgentId}' is not allowed to spawn '${childAgentId}'`,
      };
    }

    if (this.wouldCreateCycle(parentAgentId, childAgentId)) {
      return {
        allowed: false,
        reason: `Spawning '${childAgentId}' from '${parentAgentId}' would create a circular dependency`,
      };
    }

    return { allowed: true };
  }

  /**
   * Convert raw config to ExtendedAgentDefinition
   */
  private configToDefinition(config: RawAgentConfig): ExtendedAgentDefinition {
    // Convert tools
    const tools: ToolConfig[] = (config.tools ?? []).map(t => ({
      name: t.name as ToolConfig['name'],
      enabled: t.enabled,
      restrictions: {
        allowedPaths: t.allowedPaths,
        blockedCommands: t.blockedCommands,
      },
    }));

    // Convert retry config
    const retryConfig: RetryConfig = {
      maxAttempts: config.retry?.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts,
      initialDelayMs: config.retry?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
      backoffMultiplier: config.retry?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier,
      retryableErrors: config.retry?.retryableErrors ?? DEFAULT_RETRY_CONFIG.retryableErrors,
    };

    // Convert secrets
    const secretRefs: SecretReference[] = (config.secrets ?? []).map(s => ({
      name: s.name,
      ref: s.ref,
      required: s.required,
    }));

    return {
      id: config.id,
      name: config.name,
      description: config.description,
      category: config.category as AgentCategory,
      capabilities: config.capabilities as AgentCapability[],
      systemPrompt: config.systemPrompt,
      tools,
      retryConfig,
      secretRefs,
      maxExecutionTimeMs: config.maxExecutionTimeMs ?? this.defaultMaxExecutionTimeMs,
      maxTurns: config.maxTurns ?? this.defaultMaxTurns,
      model: config.model ?? this.defaultModel,
      canSpawnSubagents: config.canSpawnSubagents ?? false,
      allowedSubagents: config.allowedSubagents,
    };
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultRegistry: AgentRegistry | null = null;

export function getAgentRegistry(config?: AgentRegistryConfig): AgentRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new AgentRegistry(config);
  }
  return defaultRegistry;
}

export function resetAgentRegistry(): void {
  defaultRegistry = null;
}
