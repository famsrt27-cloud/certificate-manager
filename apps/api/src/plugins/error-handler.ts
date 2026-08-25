import { createErrorResponse } from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";

interface FastifyBadRequest {
  readonly statusCode: number;
  readonly code: string;
}

const isFastifyBadRequest = (error: unknown): error is FastifyBadRequest =>
  typeof error === "object"
  && error !== null
  && "statusCode" in error
  && error.statusCode === 400
  && "code" in error
  && typeof error.code === "string"
  && error.code.startsWith("FST_ERR_");

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(createErrorResponse("NOT_FOUND", "The requested resource was not found.", request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    const publicRequest = request.url.startsWith("/api/public/");
    if (error instanceof ApplicationError) {
      void reply
        .status(error.statusCode)
        .send(createErrorResponse(error.code, error.message, request.id));
      return;
    }

    if (isFastifyBadRequest(error)) {
      void reply
        .status(400)
        .send(createErrorResponse(
          publicRequest ? "PUBLIC_REQUEST_FAILED" : "VALIDATION_FAILED",
          publicRequest ? "The request could not be completed." : "The request could not be processed.",
          request.id
        ));
      return;
    }

    request.log.error({ err: error, error_code: "INTERNAL_ERROR" }, "request failed");
    void reply
      .status(500)
      .send(createErrorResponse(
        publicRequest ? "PUBLIC_REQUEST_FAILED" : "INTERNAL_ERROR",
        publicRequest ? "The request could not be completed." : "The request could not be processed.",
        request.id
      ));
  });
};
