# Kubernetes with Helm

The default chart is designed for k3s with MetalLB. It creates a dedicated `LoadBalancer` address and a persistent 5 GiB volume for the SQLite database and downloaded images.

## What the default installation creates

- The public multi-platform image matching the chart's app version, for example `ghcr.io/dedkola/bladevault:v1.3.1`.
- A 5 GiB `ReadWriteOnce` PVC at `/app/data` using the default StorageClass, annotated with `helm.sh/resource-policy: keep`.
- One replica with the `Recreate` strategy to avoid simultaneous access to the SQLite database from multiple pods.
- A dedicated `LoadBalancer` service, suitable for k3s with MetalLB.

## Install

```bash
helm repo add bladevault https://dedkola.github.io/bladevault

helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace
```

Find the service's external address, then open `http://<EXTERNAL-IP>`:

```bash
kubectl get service bladevault --namespace bladevault
```

If the repository was already added, run `helm repo update bladevault` before installing.

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

## Use an existing claim

```bash
helm install bladevault bladevault/bladevault \
  --namespace bladevault \
  --create-namespace \
  --set persistence.existingClaim=bladevault-data
```

## Update BladeVault

Each BladeVault release publishes a matching Helm chart and immutable container image. After the GitHub **Build & Push Docker Image** and **Publish Helm Repository** workflows complete, refresh the repository and upgrade the release:

```bash
helm repo update bladevault
helm upgrade bladevault bladevault/bladevault --namespace bladevault --wait
```

The chart version, displayed app version, and default image tag match the BladeVault release. For example, chart `1.3.1` installs image `v1.3.1`.

If you explicitly override `image.tag=latest`, recreate the pod after a new image is published because the mutable tag does not change the Deployment:

```bash
kubectl rollout restart deployment/bladevault --namespace bladevault
kubectl rollout status deployment/bladevault --namespace bladevault
```

## Remove BladeVault

```bash
helm uninstall bladevault --namespace bladevault
```

The chart keeps the `bladevault-data` PVC so uninstalling does not remove your collection. To permanently delete the stored database and images too:

```bash
kubectl delete pvc bladevault-data --namespace bladevault
kubectl delete namespace bladevault
```

Back up the PVC before storage maintenance or cluster removal. It holds the vault database and every downloaded image. For a portable archive, follow [Back up and restore your vault](../guides/back-up-and-restore-your-vault.md).
