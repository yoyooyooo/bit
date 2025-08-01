import { MainRuntime } from '@teambit/cli';
import type { Server } from 'http';
import type { SlotRegistry } from '@teambit/harmony';
import { Slot } from '@teambit/harmony';
import type { Logger, LoggerMain } from '@teambit/logger';
import { LoggerAspect } from '@teambit/logger';
import type { Express } from 'express';
import express from 'express';
import { concat, flatten, lowerCase, sortBy, omit } from 'lodash';
import bodyParser from 'body-parser';
import { ExpressAspect } from './express.aspect';
import { catchErrors } from './middlewares';
import type { Middleware, Request, Response, Route } from './types';
import { Verb } from './types';
import type { MiddlewareManifest } from './middleware-manifest';

export type ExpressConfig = {
  port: number;
  namespace: string;
  loggerIgnorePath: string[];
};

export type MiddlewareSlot = SlotRegistry<MiddlewareManifest[]>;

export type RouteSlot = SlotRegistry<Route[]>;

export class ExpressMain {
  static runtime = MainRuntime;

  constructor(
    /**
     * extension config
     */
    readonly config: ExpressConfig,

    /**
     * slot for registering graphql modules
     */
    private moduleSlot: RouteSlot,

    /**
     * logger extension.
     */
    readonly logger: Logger,

    readonly middlewareSlot: MiddlewareSlot
  ) {}

  /**
   * start an express server.
   */
  async listen(port?: number): Promise<Server> {
    const serverPort = port || this.config.port;
    const app = this.createApp();
    return app.listen(serverPort);
  }

  static(root: string, opts?: any): any {
    return express.static(root, opts);
  }

  /**
   * register a new express routes.
   * route will be added as `/api/${route}`
   */
  register(routes: Route[]) {
    this.moduleSlot.register(routes);
    return this;
  }

  /**
   * register a new middleware into express.
   */
  registerMiddleware(middlewares: MiddlewareManifest[]) {
    this.middlewareSlot.register(middlewares);
    return this;
  }

  private createRootRoutes() {
    // TODO: @guy refactor health to service aspect.
    return [
      {
        namespace: ExpressAspect.id,
        method: 'get',
        path: '/_health',
        disableNamespace: false,
        priority: 0,
        middlewares: [async (req: Request, res: Response) => res.send('ok')],
      },
    ];
  }

  createApp(expressApp?: Express, options?: { disableBodyParser: true }): Express {
    const internalRoutes = this.createRootRoutes();
    const routes = this.createRoutes();
    const allRoutes = concat(routes, internalRoutes);
    const sortedRoutes = sortBy(allRoutes, (r) => r.priority).reverse();
    const app = expressApp || express();
    app.use((req, res, next) => {
      if (this.config.loggerIgnorePath.includes(req.url)) return next();
      const headers = omit(req.headers, ['cookie', 'authorization']);
      this.logger.debug(`express got a request to a URL: ${req.url}', headers:`, headers);
      return next();
    });
    if (!options?.disableBodyParser) this.bodyParser(app);

    const middlewaresSlot = this.middlewareSlot.values().flat();
    middlewaresSlot.forEach(({ route, middleware }) => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      if (!route) app.use(middleware);
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      if (route) app.use(route, middleware);
    });

    sortedRoutes.forEach((routeInfo) => {
      const { method, path, middlewares, disableNamespace } = routeInfo;
      // TODO: @guy make sure to support single middleware here.
      const namespace = disableNamespace ? '' : `/${this.config.namespace}`;
      app[method](`${namespace}${path}`, this.catchErrorsMiddlewares(middlewares));
    });

    return app;
  }

  private createRoutes() {
    const routesSlots = this.moduleSlot.toArray();
    const routeEntries = routesSlots.map(([, routes]) => {
      return routes.map((route) => {
        const middlewares = flatten([this.verbValidation(route), route.middlewares]);
        return {
          method: lowerCase(route.method),
          path: route.route,
          disableNamespace: route.disableNamespace,
          middlewares,
          priority: route.priority || 0,
        };
      });
    });

    return flatten(routeEntries);
  }

  private verbValidation(route: Route): Middleware {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!route.verb) return next();
      const verb = req.headers['x-verb'] || Verb.READ;
      if (verb !== route.verb) {
        res.status(403);
        return res.jsonp({ message: 'You are not authorized', error: 'forbidden' });
      }
      return next();
    };
  }

  private catchErrorsMiddlewares(middlewares: Middleware[]) {
    return middlewares.map((middleware) => catchErrors(middleware));
  }

  private bodyParser(app: Express) {
    app.use(bodyParser.json({ limit: '5000mb' }));
    app.use(bodyParser.raw({ type: 'application/octet-stream', limit: '5000mb' }));
  }

  static slots = [Slot.withType<Route[]>(), Slot.withType<MiddlewareManifest[]>()];
  static dependencies = [LoggerAspect];

  static defaultConfig = {
    port: 4001,
    namespace: 'api',
    loggerIgnorePath: ['/api/_health'],
  };

  static async provider(
    [loggerFactory]: [LoggerMain],
    config: ExpressConfig,
    [routeSlot, middlewareSlot]: [RouteSlot, MiddlewareSlot]
  ) {
    const logger = loggerFactory.createLogger(ExpressAspect.id);
    return new ExpressMain(config, routeSlot, logger, middlewareSlot);
  }
}

ExpressAspect.addRuntime(ExpressMain);
