# BladeVault Helm Chart

This chart installs [BladeVault](https://github.com/dedkola/bladevault) with a
persistent volume for its SQLite database and downloaded images.

## First installation

```bash
helm repo add bladevault https://dedkola.github.io/bladevault

helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace
```

The default installation:

- pulls the public multi-platform `ghcr.io/dedkola/bladevault:latest` image;
- creates a 5 GiB `ReadWriteOnce` PVC at `/app/data` using the default
  StorageClass;
- uses one replica and the `Recreate` strategy for SQLite safety; and
- creates a dedicated `LoadBalancer` service, suitable for k3s with MetalLB.

Get the address and open `http://<EXTERNAL-IP>`:

```bash
kubectl get service bladevault --namespace bladevault
```

If the repository was added previously, refresh it before installing:

```bash
helm repo update bladevault
```

## NGINX ingress with a hostname

Use a hostname when an ingress controller already routes other applications:

```bash
helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace \
  --set service.type=ClusterIP \
  --set ingress.enabled=true \
  --set 'ingress.hosts[0].host=bladevault.example.com' \
  --set 'ingress.hosts[0].paths[0].path=/' \
  --set 'ingress.hosts[0].paths[0].pathType=Prefix' \
  --set 'ingress.hosts[0].paths[0].servicePort=80'
```

## Upgrade

```bash
helm repo update bladevault
helm upgrade bladevault bladevault/bladevault --namespace bladevault
kubectl rollout status deployment/bladevault --namespace bladevault
```

The `latest` image is pulled whenever Kubernetes creates a pod. To pull a newly
published image under the same tag without a chart change:

```bash
kubectl rollout restart deployment/bladevault --namespace bladevault
```

For reproducible production deployments, set `image.tag` to an immutable tag.

## Persistent data

The chart annotates its generated PVC with `helm.sh/resource-policy: keep`, so
uninstalling the release does not delete collection data. Back up the PVC before
storage maintenance or cluster removal.

To use an existing claim:

```bash
helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace \
  --set persistence.existingClaim=bladevault-data
```
