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

- pulls the public multi-platform image matching the chart's app version, such
  as `ghcr.io/dedkola/bladevault:v0.2.46`;
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

## Update BladeVault

Each BladeVault release publishes a matching Helm chart and immutable container
image. After the GitHub **Build & Push Docker Image** and **Publish Helm
Repository** workflows complete, refresh the repository and upgrade the release:

```bash
helm repo update bladevault
helm upgrade bladevault bladevault/bladevault --namespace bladevault --wait
```

The chart version, displayed app version, and default image tag match the
BladeVault release. For example, chart `0.2.46` installs image `v0.2.46`.

To opt into the mutable `latest` image instead, set it explicitly. Recreate the
pod after future image publications because the tag itself does not change:

```bash
helm upgrade bladevault bladevault/bladevault \
  --namespace bladevault \
  --set image.tag=latest

kubectl rollout restart deployment/bladevault --namespace bladevault
kubectl rollout status deployment/bladevault --namespace bladevault
```

## Remove BladeVault

```bash
helm uninstall bladevault --namespace bladevault
```

The generated `bladevault-data` PVC is retained so uninstalling does not remove
the collection. To permanently delete the database and downloaded images too:

```bash
kubectl delete pvc bladevault-data --namespace bladevault
kubectl delete namespace bladevault
```

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
