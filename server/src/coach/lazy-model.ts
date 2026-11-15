/** The Anthropic model factory, loaded with the coach agent on first use instead of at startup. */
import type { CoachDeps } from './deps.js';

export function lazyAnthropicModelFactory(apiKey: string): Pick<CoachDeps, 'createModel' | 'prepare'> {
  let factory: CoachDeps['createModel'] | undefined;
  let loading: Promise<void> | undefined;
  return {
    prepare() {
      loading ??= import('./agent.js').then(
        ({ anthropicModelFactory }) => {
          factory = anthropicModelFactory(apiKey);
        },
        (error) => {
          loading = undefined;
          throw error;
        },
      );
      return loading;
    },
    createModel(role) {
      if (!factory) throw new Error('the coach model is not loaded yet: await prepare() first');
      return factory(role);
    },
  };
}
