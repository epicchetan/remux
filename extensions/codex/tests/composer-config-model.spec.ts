import { expect, type Page, test } from '@playwright/test';

type HostRequest = {
  id?: number | string;
  method?: string;
  params?: unknown;
  type?: string;
};

async function installMockRemuxHost(page: Page) {
  await page.addInitScript(() => {
    const capturedMessages: HostRequest[] = [];
    let revision = 1;
    let config = {
      intelligence: 'high',
      model: null as string | null,
      reviewMode: 'auto-review',
      revision: String(revision),
      speed: 'default',
    };

    function dispatchHostMessage(message: unknown) {
      const event = new MessageEvent('message', {
        data: JSON.stringify(message),
      });
      window.dispatchEvent(event);
      document.dispatchEvent(event);
    }

    function postResult(request: HostRequest, result: unknown) {
      dispatchHostMessage({
        id: request.id,
        result,
        type: 'remux/response',
      });
    }

    function resultFor(request: HostRequest) {
      switch (request.method) {
        case 'remux/codex/composer/config/read':
          return { config };
        case 'remux/codex/composer/config/write': {
          const params =
            request.params && typeof request.params === 'object'
              ? (request.params as Partial<typeof config> & { threadId?: unknown })
              : {};
          revision += 1;
          config = {
            ...config,
            ...(typeof params.intelligence === 'string' ? { intelligence: params.intelligence } : {}),
            ...(typeof params.model === 'string' ? { model: params.model } : {}),
            ...(typeof params.reviewMode === 'string' ? { reviewMode: params.reviewMode } : {}),
            ...(typeof params.speed === 'string' ? { speed: params.speed } : {}),
            revision: String(revision),
          };
          return { config };
        }
        case 'remux/codex/models/read':
          return {
            models: [
              {
                defaultReasoningEffort: 'high',
                defaultServiceTier: 'default',
                description: 'Balanced default Codex model',
                displayName: 'GPT-5.5',
                id: 'gpt-5.5',
                isDefault: true,
                model: 'gpt-5.5',
                serviceTiers: [
                  { description: 'Normal usage', id: 'default', name: 'Default' },
                ],
                supportedReasoningEfforts: [
                  { description: 'Quick pass', reasoningEffort: 'low' },
                  { description: 'Balanced reasoning', reasoningEffort: 'medium' },
                  { description: 'Deep reasoning', reasoningEffort: 'high' },
                  { description: 'Extended reasoning', reasoningEffort: 'xhigh' },
                ],
              },
              {
                defaultReasoningEffort: 'high',
                defaultServiceTier: 'default',
                description: 'Balanced next-gen model',
                displayName: 'GPT-5.6 Terra',
                id: 'gpt-5.6-terra',
                isDefault: false,
                model: 'gpt-5.6-terra',
                serviceTiers: [
                  { description: 'Normal usage', id: 'default', name: 'Default' },
                ],
                supportedReasoningEfforts: [
                  { description: 'Balanced reasoning', reasoningEffort: 'medium' },
                  { description: 'Deep reasoning', reasoningEffort: 'high' },
                  { description: 'Extended reasoning', reasoningEffort: 'xhigh' },
                  { description: 'Maximum reasoning', reasoningEffort: 'max' },
                ],
              },
            ],
          };
        case 'remux/codex/thread/resources/read': {
          const params =
            request.params && typeof request.params === 'object'
              ? (request.params as { requests?: unknown })
              : {};
          const requests = Array.isArray(params.requests) ? params.requests : [];
          return {
            resources: requests.map((resourceRequest, requestIndex) => {
              const typedRequest =
                resourceRequest && typeof resourceRequest === 'object'
                  ? (resourceRequest as { type?: unknown })
                  : {};

              if (typedRequest.type === 'threadHistory') {
                return {
                  key: 'threadHistory:updated_at:desc:50::false:',
                  requestIndex,
                  revision: 'mock-history-revision',
                  status: 'ok',
                  value: {
                    backwardsCursor: null,
                    nextCursor: null,
                    revision: 'mock-history-revision',
                    threads: [],
                  },
                };
              }

              return {
                key: String(typedRequest.type ?? 'unknown'),
                requestIndex,
                revision: 'mock-resource-revision',
                status: 'missing',
              };
            }),
          };
        }
        case 'host/viewport/get':
          return {
            keyboardHeight: 0,
            keyboardVisible: false,
            visibleBottom: window.innerHeight,
            visibleTop: 0,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth,
          };
        default:
          return null;
      }
    }

    Object.defineProperty(window, '__remuxWebViewMessages', {
      configurable: true,
      value: capturedMessages,
    });

    Object.defineProperty(window, 'ReactNativeWebView', {
      configurable: true,
      value: {
        postMessage(rawMessage: string) {
          const request = JSON.parse(rawMessage) as HostRequest;
          capturedMessages.push(request);

          if (request.type === 'ready' || request.type === 'remux/ready') {
            dispatchHostMessage({
              error: null,
              status: {
                cwd: '/tmp/remux',
                type: 'connected',
                websocketUrl: 'ws://127.0.0.1:48124',
              },
              type: 'remux/status',
            });
            return;
          }

          if (request.id != null && request.method) {
            postResult(request, resultFor(request));
          }
        },
      },
    });
  });
}

async function capturedHostRequests(page: Page) {
  return page.evaluate(() =>
    ((window as unknown as { __remuxWebViewMessages?: HostRequest[] }).__remuxWebViewMessages ?? []),
  );
}

test('selects composer model from catalog and updates reasoning options', async ({ page }) => {
  await installMockRemuxHost(page);

  await page.goto('/viewers/codex/');

  await page.getByRole('button', { name: 'Preferences' }).click();
  const panel = page.locator('[data-remux-composer-config-panel]');

  await expect(panel.getByRole('button', { name: 'GPT-5.5' })).toBeVisible();

  await panel.getByRole('button', { name: 'GPT-5.5' }).click();
  await expect(panel.getByRole('button', { name: /GPT-5\.6 Terra/ })).toBeVisible();
  await panel.getByRole('button', { name: /GPT-5\.6 Terra/ }).click();

  await expect
    .poll(async () => {
      const requests = await capturedHostRequests(page);
      return requests.some((request) => (
        request.method === 'remux/codex/composer/config/write' &&
        request.params &&
        typeof request.params === 'object' &&
        (request.params as { model?: unknown }).model === 'gpt-5.6-terra'
      ));
    })
    .toBe(true);
  await expect(panel.getByRole('button', { name: 'GPT-5.6 Terra' })).toBeVisible();

  await panel.getByRole('button', { name: 'High' }).click();
  await expect(panel.getByRole('button', { name: /Max/ })).toBeVisible();
});
