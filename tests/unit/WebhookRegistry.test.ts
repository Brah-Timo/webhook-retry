import { describe, it, expect, vi } from 'vitest';
import { WebhookRegistry } from '../../src/core/WebhookRegistry.js';

describe('WebhookRegistry', () => {
  it('registers and retrieves a handler', () => {
    const registry = new WebhookRegistry();
    const handler = vi.fn();

    registry.on('payment.success', handler);
    const handlers = registry.getHandlers('payment.success');

    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.handler).toBe(handler);
  });

  it('returns empty array for unregistered event type', () => {
    const registry = new WebhookRegistry();
    expect(registry.getHandlers('unknown.event')).toHaveLength(0);
  });

  it('registers multiple handlers for same event type', () => {
    const registry = new WebhookRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();

    registry.on('order.created', h1);
    registry.on('order.created', h2);

    expect(registry.getHandlers('order.created')).toHaveLength(2);
  });

  it('onMany registers across multiple event types', () => {
    const registry = new WebhookRegistry();
    const handler = vi.fn();

    registry.onMany(['payment.success', 'payment.failed'], handler);

    expect(registry.hasHandlers('payment.success')).toBe(true);
    expect(registry.hasHandlers('payment.failed')).toBe(true);
    expect(registry.hasHandlers('other.event')).toBe(false);
  });

  it('off removes a specific handler', () => {
    const registry = new WebhookRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();

    registry.on('event.x', h1);
    registry.on('event.x', h2);
    registry.off('event.x', h1);

    const handlers = registry.getHandlers('event.x');
    expect(handlers).toHaveLength(1);
    expect(handlers[0]!.handler).toBe(h2);
  });

  it('offAll removes all handlers for a type', () => {
    const registry = new WebhookRegistry();
    registry.on('event.x', vi.fn());
    registry.on('event.x', vi.fn());
    registry.offAll('event.x');
    expect(registry.hasHandlers('event.x')).toBe(false);
  });

  it('getRegisteredEvents returns all event types', () => {
    const registry = new WebhookRegistry();
    registry.on('event.a', vi.fn());
    registry.on('event.b', vi.fn());

    const events = registry.getRegisteredEvents();
    expect(events).toContain('event.a');
    expect(events).toContain('event.b');
  });

  it('size reflects total handler count', () => {
    const registry = new WebhookRegistry();
    registry.on('a', vi.fn());
    registry.on('a', vi.fn());
    registry.on('b', vi.fn());
    expect(registry.size).toBe(3);
  });

  it('getSummary returns correct shape', () => {
    const registry = new WebhookRegistry();
    registry.on('order.created', vi.fn());

    const summary = registry.getSummary();
    expect(summary[0]).toMatchObject({
      eventType:    'order.created',
      handlerCount: 1,
    });
  });

  it('auto-generates handler name when function is anonymous', () => {
    const registry = new WebhookRegistry();
    // Arrow functions have empty .name
    const name = registry.on('event.x', async () => {});
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});
