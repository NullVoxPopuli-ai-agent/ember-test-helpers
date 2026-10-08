import type { Resolver } from '@ember/owner';
import ApplicationInstance from '@ember/application/instance';
import Application from '@ember/application';
import { destroy, isDestroyed, isDestroying } from '@ember/destroyable';
import { Registry } from '@ember/-internals/container';

import type { FullName } from '@ember/owner';

import { assert } from '@ember/debug';
import { join, schedule } from '@ember/runloop';

/**
 * Adds methods that are normally only on registry to the container. This is largely to support the legacy APIs
 * that are not using `owner` (but are still using `this.container`).
 *
 * @private
 * @param {Object} container  the container to modify
 */
function exposeRegistryMethodsWithoutDeprecations(container: any) {
  const methods = [
    'register',
    'unregister',
    'resolve',
    'normalize',
    'typeInjection',
    'injection',
    'factoryInjection',
    'factoryTypeInjection',
    'has',
    'options',
    'optionsForType',
  ];

  for (let i = 0, l = methods.length; i < l; i++) {
    const methodName = methods[i];

    if (methodName && methodName in container) {
      const knownMethod = methodName;
      container[knownMethod] = function (...args: unknown[]) {
        return container._registry[knownMethod](...args);
      };
    }
  }
}

// NOTE: this is the same as what `EngineInstance`/`ApplicationInstance`
// implement, and is thus a superset of the `InternalOwner` contract from Ember
// itself.

/**
 * A plain class, with no `EmberObject` and no mixins.
 *
 * Ember builds its owners from:
 * - `EmberObject`
 * - `RegistryProxyMixin`
 * - `ContainerProxyMixin`
 *
 * Ember deprecates these:
 * - RFC 1117 deprecates classic classes.
 * - RFC 1234 deprecates `EmberObject`.
 *
 * So this class has the methods of both mixins as its own methods.
 */
class Owner {
  _emberTestHelpersMockOwner = true;

  /**
   * SAFETY: these are private API.
   */
  __registry__: any;
  __container__: any;

  constructor(registry: unknown) {
    this.__registry__ = registry;
  }

  get isDestroying() {
    return isDestroying(this);
  }

  get isDestroyed() {
    return isDestroyed(this);
  }

  resolveRegistration(fullName: FullName) {
    assert(
      'fullName must be a proper full name',
      this.__registry__.isValidFullName(fullName),
    );

    return this.__registry__.resolve(fullName);
  }

  register(...args: unknown[]) {
    return this.__registry__.register(...args);
  }

  hasRegistration(...args: unknown[]) {
    return this.__registry__.has(...args);
  }

  registeredOption(...args: unknown[]) {
    return this.__registry__.getOption(...args);
  }

  registerOptions(...args: unknown[]) {
    return this.__registry__.options(...args);
  }

  registeredOptions(...args: unknown[]) {
    return this.__registry__.getOptions(...args);
  }

  registerOptionsForType(...args: unknown[]) {
    return this.__registry__.optionsForType(...args);
  }

  registeredOptionsForType(...args: unknown[]) {
    return this.__registry__.getOptionsForType(...args);
  }

  ownerInjection() {
    return this.__container__.ownerInjection();
  }

  lookup(fullName: FullName, options?: object) {
    return this.__container__.lookup(fullName, options);
  }

  factoryFor(fullName: FullName) {
    return this.__container__.factoryFor(fullName);
  }

  destroy() {
    const container = this.__container__;

    if (container) {
      join(() => {
        container.destroy();
        schedule('destroy', container, 'finalizeDestroy');
      });
    }

    destroy(this);

    return this;
  }

  /* eslint-disable valid-jsdoc */
  /**
   * Unregister a factory and its instance.
   *
   * Also clears any cached instances of the unregistered factory.
   *
   * @param {string} fullName Name of the factory to unregister.
   *
   * @see {@link https://github.com/emberjs/ember.js/pull/12680}
   * @see {@link https://github.com/emberjs/ember.js/blob/v4.5.0-alpha.5/packages/%40ember/engine/instance.ts#L152-L167}
   */
  /* eslint-enable valid-jsdoc */
  unregister(fullName: FullName) {
    this.__container__.reset(fullName);
    this.__registry__.unregister(fullName);
  }
}

/**
 * @private
 * @param {Object} resolver the resolver to use with the registry
 * @returns {Object} owner, container, registry
 */
export default function buildRegistry(resolver: Resolver) {
  const namespace = new Application();
  // @ts-ignore: this is actually the correcct type, but there was a typo in
  // Ember's docs for many years which meant that there was a matching problem
  // in the types for Ember's definition of `Engine`. Once we require at least
  // Ember 5.1 (in some future breaking change), this ts-ignore can be removed.
  namespace.Resolver = {
    create() {
      return resolver;
    },
  };

  // @ts-ignore: this is private API.
  const fallbackRegistry = Application.buildRegistry(namespace);

  const registry = new Registry({
    fallback: fallbackRegistry,
  });

  // @ts-ignore: this is private API.
  ApplicationInstance.setupRegistry(registry);

  // these properties are set on the fallback registry by `buildRegistry`
  // and on the primary registry within the ApplicationInstance constructor
  // but we need to manually recreate them since ApplicationInstance's are not
  // exposed externally
  // @ts-ignore: this is private API.
  registry.normalizeFullName = fallbackRegistry.normalizeFullName;
  // @ts-ignore: this is private API.
  registry.makeToString = fallbackRegistry.makeToString;
  // @ts-ignore: this is private API.
  registry.describe = fallbackRegistry.describe;

  const owner = new Owner(registry);

  // @ts-ignore: this is private API.
  const container = registry.container({ owner: owner });
  // @ts-ignore: this is private API.
  owner.__container__ = container;

  exposeRegistryMethodsWithoutDeprecations(container);

  return {
    registry,
    container,
    owner,
  };
}
