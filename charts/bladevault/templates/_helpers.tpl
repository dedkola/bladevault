{{/* Expand the chart name. */}}
{{- define "bladevault.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a fully qualified application name. */}}
{{- define "bladevault.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Chart label. */}}
{{- define "bladevault.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels. */}}
{{- define "bladevault.labels" -}}
helm.sh/chart: {{ include "bladevault.chart" . }}
{{ include "bladevault.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels. */}}
{{- define "bladevault.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bladevault.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* PersistentVolumeClaim name. */}}
{{- define "bladevault.pvcName" -}}
{{- default (printf "%s-data" (include "bladevault.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}
