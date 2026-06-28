export type CodexComposerIntelligence = 'low' | 'medium' | 'high' | 'xhigh';
export type CodexComposerSpeed = 'default' | 'fast';
export type CodexComposerReviewMode = 'auto-review' | 'default' | 'full-access';

export type CodexComposerConfig = {
  intelligence: CodexComposerIntelligence;
  reviewMode: CodexComposerReviewMode;
  revision: string;
  speed: CodexComposerSpeed;
};

export type CodexComposerConfigReadResponse = {
  config: CodexComposerConfig;
};

export type CodexComposerConfigWriteParams = Partial<{
  intelligence: CodexComposerIntelligence;
  reviewMode: CodexComposerReviewMode;
  speed: CodexComposerSpeed;
  threadId: string | null;
}>;

export type CodexComposerConfigWriteResponse = CodexComposerConfigReadResponse;
