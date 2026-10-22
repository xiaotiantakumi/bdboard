export interface PublicAddresses {
  readonly ipv4: string | null;
  readonly ipv6: string | null;
}

export interface PublicAddressProbe {
  probe(tunnelUrl: string): Promise<PublicAddresses>;
}
