# GoldTrack — always-on deployment (GCP VM)

Goal: run GoldTrack 24/7 off the laptop so the nightly 21:00 ET pipeline fires every day and the history compounds. Small VM in the same GCP project as the Cloud SQL "warehouse" instance.

Placeholders filled at deploy time: `PROJECT`, `ZONE` (co-locate with the DB, us-east4), `VM=goldtrack`.

## 0. Auth (Daniel, interactive)
```
gcloud auth login
gcloud config set project PROJECT
gcloud sql instances list        # confirm the "warehouse" instance + region
```

## 1. Create the VM (e2-micro, Debian 12)
```
gcloud compute instances create goldtrack \
  --project=PROJECT --zone=us-east4-a \
  --machine-type=e2-micro --image-family=debian-12 --image-project=debian-cloud \
  --tags=goldtrack
```

## 2. Let the VM reach Cloud SQL
Add the VM's external IP to the Cloud SQL instance's authorized networks:
```
VM_IP=$(gcloud compute instances describe goldtrack --zone=us-east4-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
gcloud sql instances patch INSTANCE --authorized-networks="$VM_IP/32" --quiet
```
(If other authorized networks already exist, include them too — patch replaces the list.)

## 3. Ship the code + secrets
```
gcloud compute scp --zone=us-east4-a --recurse \
  --exclude=node_modules --exclude=.git --exclude=dist \
  /Users/danielanthony/project/GoldTrack goldtrack:/tmp/goldtrack
gcloud compute ssh goldtrack --zone=us-east4-a --command \
  "sudo mkdir -p /opt/goldtrack && sudo cp -r /tmp/goldtrack/* /tmp/goldtrack/.env.local /opt/goldtrack/"
```
(.env.local carries PG* creds + ANTHROPIC_API_KEY — it must land in /opt/goldtrack.)

## 4. Provision + start
```
gcloud compute ssh goldtrack --zone=us-east4-a --command "sudo bash /opt/goldtrack/deploy/provision.sh"
```

## 5. Verify
```
gcloud compute ssh goldtrack --zone=us-east4-a --command "systemctl is-active goldtrack && curl -s localhost:3000/api/health || true"
```
The service stays up (Restart=always); the 21:00 ET cron fires nightly while it runs.

## Notes
- e2-micro is ~$7/mo. Bump to e2-small if the nightly pipeline needs more memory.
- To reach the dashboard from a browser, either open port 3000 via a firewall rule + the VM IP, or keep it private and use an SSH tunnel. Decide based on whether the dashboard should be public.
- Backups: full dump already at ~/GoldTrack-backups/warehouse-full-2026-07-15.dump.
