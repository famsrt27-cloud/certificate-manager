import bcrypt from "bcrypt";

export const BCRYPT_MAX_PASSWORD_BYTES = 72;
export const MINIMUM_BCRYPT_COST = 12;
export const MINIMUM_NEW_PASSWORD_CHARACTERS = 12;

export class InvalidPasswordInputError extends Error {
  constructor() {
    super("Password input is outside the supported bcrypt boundary");
    this.name = "InvalidPasswordInputError";
  }
}

export const passwordUtf8Length = (password: string): number => Buffer.byteLength(password, "utf8");

export const isPasswordWithinBcryptBoundary = (password: string): boolean => {
  const bytes = passwordUtf8Length(password);
  return bytes > 0 && bytes <= BCRYPT_MAX_PASSWORD_BYTES;
};

const assertPasswordInput = (password: string): void => {
  if (!isPasswordWithinBcryptBoundary(password)) {
    throw new InvalidPasswordInputError();
  }
};

const assertBcryptCost = (cost: number): void => {
  if (!Number.isInteger(cost) || cost < MINIMUM_BCRYPT_COST || cost > 15) {
    throw new Error("Bcrypt cost must be an integer between 12 and 15");
  }
};

export const hashPassword = async (password: string, cost: number): Promise<string> => {
  assertPasswordInput(password);
  if ([...password].length < MINIMUM_NEW_PASSWORD_CHARACTERS) {
    throw new InvalidPasswordInputError();
  }
  assertBcryptCost(cost);
  return bcrypt.hash(password, cost);
};

export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  if (!isPasswordWithinBcryptBoundary(password)) return false;
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
};
