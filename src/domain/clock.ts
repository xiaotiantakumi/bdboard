export interface Clock {
  now(): Date;
}

export function fixedClock(at: Date): Clock {
  const fixedTime = at.getTime();

  return {
    now(): Date {
      return new Date(fixedTime);
    },
  };
}
