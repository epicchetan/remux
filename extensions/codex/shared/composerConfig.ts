export type CodexComposerIntelligence = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type CodexComposerSpeed = 'default' | 'fast';
export type CodexComposerReviewMode = 'auto-review' | 'default' | 'full-access';

export type CodexComposerConfig = {
  intelligence: CodexComposerIntelligence;
  model: string | null;
  reviewMode: CodexComposerReviewMode;
  revision: string;
  speed: CodexComposerSpeed;
};

export type CodexComposerConfigReadResponse = {
  config: CodexComposerConfig;
};

export type CodexComposerConfigWriteParams = Partial<{
  intelligence: CodexComposerIntelligence;
  model: string;
  reviewMode: CodexComposerReviewMode;
  speed: CodexComposerSpeed;
  threadId: string | null;
}>;

export type CodexComposerConfigWriteResponse = CodexComposerConfigReadResponse;

export type CodexModelReasoningEffortOption = {
  reasoningEffort: CodexComposerIntelligence;
  description: string;
};

export type CodexModelServiceTier = { id: string; name: string; description: string };

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: CodexModelReasoningEffortOption[];
  defaultReasoningEffort: CodexComposerIntelligence;
  serviceTiers: CodexModelServiceTier[];
  defaultServiceTier?: string | null;
};

export type CodexModelsReadResponse = { models: CodexModelOption[] };
